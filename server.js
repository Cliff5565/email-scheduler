import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import sgMail from "@sendgrid/mail";
import { fileURLToPath } from "url";
import IORedis from "ioredis";
import { zonedTimeToUtc } from "date-fns-tz";
import fs from "fs";
import { EmailJob } from "./models/EmailJob.js"; // your mongoose model
import admin from "firebase-admin";
import multer from "multer";
import twilio from "twilio";
import { createDecipheriv, scryptSync } from "crypto";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Validate env vars ----------
const required = [
  "MONGO_URI",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "PROVIDER_KEY",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  process.exit(1);
}

// ---------- Firebase ----------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}
console.log("✅ Firebase admin ready");

// ---------- Mongo ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Mongo connected"))
  .catch((err) => console.error("❌ Mongo error:", err));

// ---------- Redis + BullMQ ----------
let emailQueue = null;
let redisClient = null;
if (process.env.REDIS_URL) {
  redisClient = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });
  redisClient.on("error", (e) => console.error("❌ Redis error:", e.message));
  redisClient.on("ready", () => console.log("✅ Redis ready"));
  emailQueue = new Queue("notifications", { connection: redisClient });
}

// ---------- Sendgrid ----------
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ---------- Twilio ----------
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log("✅ Twilio client ready");
} else {
  console.warn("⚠️ Twilio not configured, SMS/WhatsApp will be mocked");
}

// ---------- Crypto (AES-256-GCM) ----------
const KEY = scryptSync(process.env.PROVIDER_KEY, "scheduler-salt", 32);
const ALGO = "aes-256-gcm";

function decrypt(cipherBase64) {
  try {
    const raw = Buffer.from(cipherBase64, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(12, raw.length - 16);

    const decipher = createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch (err) {
    console.error("❌ Decryption failed:", err.message);
    throw new Error("Invalid ciphertext");
  }
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: path.join(__dirname, "uploads/") });

// ---------- Auth (Firebase) ----------
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const token = header.substring(7);
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ---------- Queue Worker ----------
if (emailQueue) {
  new Worker(
    "notifications",
    async (job) => {
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
                    content: fs
                      .readFileSync(attachment.path)
                      .toString("base64"),
                    filename: attachment.filename,
                    type: "application/octet-stream",
                    disposition: "attachment",
                  },
                ]
              : [],
          };
          await sgMail.send(msg);
          console.log("✅ Email sent to", to);
        } else if (method === "sms") {
          if (twilioClient) {
            await twilioClient.messages.create({
              body,
              from: process.env.TWILIO_PHONE_NUMBER,
              to,
            });
            console.log("✅ SMS sent to", to);
          } else console.log("📱 Mock SMS:", to, body);
        } else if (method === "whatsapp") {
          if (twilioClient) {
            await twilioClient.messages.create({
              body,
              from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
              to: `whatsapp:${to}`,
            });
            console.log("💬 WhatsApp sent to", to);
          } else console.log("💬 Mock WhatsApp:", to, body);
        }
        if (emailJobId)
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "sent",
            sentAt: new Date(),
          });
      } catch (err) {
        console.error("❌ Worker send failed:", err.message);
        if (emailJobId)
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "failed",
            error: err.message,
          });
        throw err;
      }
    },
    { connection: redisClient }
  );
}

// ---------- API ----------
app.post(
  "/api/schedule",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    try {
      const data = req.body.data ? JSON.parse(req.body.data) : req.body;
      const { to, subject, body, datetime, timezone, method } = data;

      if (!to || !body || !datetime || !timezone)
        return res.status(400).json({ error: "Missing fields" });

      const decTo = decrypt(to);
      const decBody = decrypt(body);
      const decSubject = subject ? decrypt(subject) : undefined;

      const schedTime = zonedTimeToUtc(datetime, timezone);
      const delayMs = schedTime.getTime() - Date.now();
      if (delayMs < 0)
        return res.status(400).json({ error: "Date is in the past" });

      const attachment =
        req.file && method === "email"
          ? { filename: req.file.originalname, path: req.file.path }
          : undefined;

      const job = await EmailJob.create({
        to: decTo,
        subject: decSubject,
        body: decBody,
        datetime: schedTime,
        timezone,
        originalLocalTime: datetime,
        method,
        status: "scheduled",
        userId: req.user.uid,
        attachment,
      });

      if (emailQueue) {
        await emailQueue.add(
          "sendNotification",
          {
            method,
            to: decTo,
            subject: decSubject,
            body: decBody,
            emailJobId: job._id.toString(),
            attachment,
          },
          {
            id: job._id.toString(),
            delay: delayMs,
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
          }
        );
      }

      res.json({
        message: `✅ ${method} scheduled`,
        jobId: job._id.toString(),
      });
    } catch (err) {
      console.error("❌ Schedule error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  }
);

app.get("/api/jobs", authMiddleware, async (req, res) => {
  try {
    const jobs = await EmailJob.find({ userId: req.user.uid }).sort({
      datetime: 1,
    });
    const counts = {
      email: jobs.filter(
        (j) => j.method === "email" && j.status === "scheduled"
      ).length,
      sms: jobs.filter(
        (j) => j.method === "sms" && j.status === "scheduled"
      ).length,
      whatsapp: jobs.filter(
        (j) => j.method === "whatsapp" && j.status === "scheduled"
      ).length,
    };
    res.json({ jobs, counts });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/schedule", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "schedule.html"))
);
app.get("/dashboard.html", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "dashboard.html"))
);

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on :${PORT}`)
);
