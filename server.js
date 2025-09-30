import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import sgMail from "@sendgrid/mail";
import { fileURLToPath } from "url";
import IORedis from "ioredis";
import { zonedTimeToUtc, utcToZonedTime, format } from "date-fns-tz";
import fs from "fs";
import { EmailJob } from "./models/EmailJob.js";
import admin from "firebase-admin";
import multer from "multer";
import twilio from "twilio";
import { createDecipheriv } from "crypto";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Validate env vars ----------
const requiredEnv = [
  "MONGO_URI",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "PROVIDER_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_NUMBER"
];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// ---------- Firebase Admin ----------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}
console.log("✅ Firebase Admin ready");

// ---------- Mongo ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------- Redis + BullMQ ----------
let emailQueue = null;
let redisClient = null;

// Twilio
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log("✅ Twilio ready (SMS/WhatsApp)");
}

// ---------- SendGrid ----------
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

if (process.env.REDIS_URL) {
  redisClient = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });

  redisClient.on("ready", () => console.log("✅ Redis connected"));
  emailQueue = new Queue("notifications", { connection: redisClient });

  new Worker(
    "notifications",
    async (job) => {
      console.log("📧/📱💬 Processing job:", job.id, job.data);
      const { method, to, subject, body, emailJobId, attachment } = job.data;
      try {
        if (method === "email") {
          const msg = {
            to,
            from: process.env.SENDGRID_FROM_EMAIL,
            subject,
            text: body,
            attachments: attachment
              ? [
                  {
                    content: Buffer.from(
                      await fs.promises.readFile(attachment.path)
                    ).toString("base64"),
                    filename: attachment.filename,
                    type: "application/octet-stream",
                    disposition: "attachment",
                  },
                ]
              : [],
          };
          await sgMail.send(msg);
          console.log("✅ Email sent via SendGrid:", to);
        } else if (method === "sms" && twilioClient) {
          await twilioClient.messages.create({
            body,
            from: process.env.TWILIO_PHONE_NUMBER,
            to,
          });
          console.log(`✅ SMS sent to ${to}`);
        } else if (method === "whatsapp" && twilioClient) {
          await twilioClient.messages.create({
            body,
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${to}`,
          });
          console.log(`✅ WhatsApp sent to ${to}`);
        }
        if (emailJobId) {
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "sent",
            sentAt: new Date(),
          });
        }
      } catch (err) {
        console.error("❌ Notification failed:", err.message);
        if (emailJobId) {
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "failed",
            error: err.message,
          });
        }
        throw err;
      }
    },
    { connection: redisClient }
  );
} else {
  console.warn("⚠️ REDIS_URL not set — jobs will run immediately");
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: path.join(__dirname, "uploads/") });

// ---------- Auth middleware ----------
async function authenticateFirebase(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(header.substring(7));
    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ Invalid token:", err.message);
    res.status(401).json({ error: "Invalid token" });
  }
}

// ---------- AES-256-GCM decrypt (fixed) ----------
function decrypt(encryptedText, base64Key) {
  const rawKey = Buffer.from(base64Key, "base64");
  if (rawKey.length !== 32)
    throw new Error("PROVIDER_KEY must decode to 32 bytes.");
  const buf = Buffer.from(encryptedText, "base64");
  const iv = buf.slice(0, 12);
  const ciphertextAndTag = buf.slice(12); // ciphertext + tag
  const decipher = createDecipheriv("aes-256-gcm", rawKey, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertextAndTag), decipher.final()]);
  return decrypted.toString("utf8");
}

// ---------- Example: Schedule Notification ----------
app.post("/api/schedule", authenticateFirebase, upload.single("file"), async (req, res) => {
  try {
    const data = req.body.data ? JSON.parse(req.body.data) : req.body;
    const { to, subject, body, datetime, timezone, method = "email" } = data;

    const decryptedTo = decrypt(to, process.env.PROVIDER_KEY);
    const decryptedBody = decrypt(body, process.env.PROVIDER_KEY);
    const decryptedSubject = subject ? decrypt(subject, process.env.PROVIDER_KEY) : undefined;

    const scheduledTime = zonedTimeToUtc(datetime, timezone);
    const delayMs = scheduledTime.getTime() - Date.now();

    const attachment = req.file && method === "email"
      ? { filename: req.file.originalname, path: req.file.path }
      : undefined;

    const emailJob = await EmailJob.create({
      to: decryptedTo,
      subject: method === "email" ? decryptedSubject : undefined,
      body: decryptedBody,
      datetime: scheduledTime,
      originalLocalTime: datetime,
      timezone,
      status: "scheduled",
      userId: req.user.uid,
      method,
      attachment,
    });

    if (emailQueue) {
      await emailQueue.add("sendNotification", {
        method,
        to: decryptedTo,
        subject: decryptedSubject,
        body: decryptedBody,
        emailJobId: emailJob._id.toString(),
        attachment,
      }, { id: emailJob._id.toString(), delay: delayMs, attempts: 3 });
    }

    return res.json({ message: "✅ Job scheduled", jobId: emailJob._id.toString() });
  } catch (err) {
    console.error("❌ Schedule error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- Other APIs (jobs, update, delete, logout) ----------
// keep your existing code here unchanged ...

// ---------- Static ----------
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/schedule", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "schedule.html"))
);
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
