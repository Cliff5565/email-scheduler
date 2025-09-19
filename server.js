import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import IORedis from "ioredis";
import { zonedTimeToUtc, utcToZonedTime, format } from "date-fns-tz";
import { EmailJob } from "./models/EmailJob.js";
import admin from "firebase-admin";
import multer from "multer";
import fetch from "node-fetch";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Validate env vars ----------
const requiredEnv = [
  "MONGO_URI",
  "SMTP_HOST",
  "SMTP_PORT",
  "EMAIL_USER",
  "EMAIL_PASS",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_STORAGE_BUCKET",
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
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}
const bucket = admin.storage().bucket();
console.log("✅ Firebase Admin + Storage ready");

// ---------- Mongo ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------- Redis + BullMQ ----------
let emailQueue = null;
let redisClient = null;

if (process.env.REDIS_URL) {
  redisClient = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });

  emailQueue = new Queue("notifications", { connection: redisClient });
  console.log("✅ Redis connected & queue initialized");

  // ---------- Worker ----------
  new Worker(
    "notifications",
    async (job) => {
      console.log("📧/📱 Processing job:", job.id, job.data);
      const { method, to, subject, body, emailJobId, attachment } = job.data;

      try {
        if (method === "email") {
          let attachments = [];
          if (attachment?.objectName) {
            const fileRef = bucket.file(attachment.objectName);
            const [signedUrl] = await fileRef.getSignedUrl({
              action: "read",
              expires: Date.now() + 60 * 60 * 1000, // valid 1 hour
            });
            const resp = await fetch(signedUrl);
            const buffer = await resp.buffer();
            attachments = [
              { filename: attachment.filename, content: buffer },
            ];
          }

          const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to,
            subject,
            text: body,
            attachments,
          });
          console.log("✅ Email sent:", info.messageId);
        } else if (method === "sms") {
          console.log(`📱 Mock SMS to ${to}: ${body}`);
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
  console.warn("⚠️ REDIS_URL not set — notifications sent immediately");
}

// ---------- Nodemailer ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Multer (Memory) ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Auth ----------
async function authenticateFirebase(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "❌ Unauthorized" });
  }
  try {
    const idToken = authHeader.substring(7);
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ Invalid token:", err.message);
    return res.status(401).json({ error: "❌ Invalid/expired token" });
  }
}

// ---------- Schedule ----------
app.post("/schedule", authenticateFirebase, upload.single("file"), async (req, res) => {
  try {
    const data = req.body.data ? JSON.parse(req.body.data) : req.body;
    const { to, subject, body, datetime, timezone, method = "email" } = data;

    if (!to || !body || !datetime || !timezone) {
      return res.status(400).json({ error: "❌ Missing required fields" });
    }
    if (!Intl.supportedValuesOf("timeZone").includes(timezone)) {
      return res.status(400).json({ error: "❌ Invalid timezone" });
    }

    let scheduledTime;
    try {
      scheduledTime = zonedTimeToUtc(datetime, timezone);
    } catch {
      return res.status(400).json({ error: "❌ Invalid datetime" });
    }

    const delayMs = scheduledTime.getTime() - Date.now();
    if (delayMs < 0) {
      return res.status(400).json({ error: "❌ Date is in the past" });
    }

    // Upload to Storage and store object name only
    let attachmentMeta = undefined;
    if (req.file && method === "email") {
      const uniqueName = `${Date.now()}-${req.file.originalname}`;
      const fileRef = bucket.file(uniqueName);

      await fileRef.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
      });

      attachmentMeta = {
        filename: req.file.originalname,
        objectName: uniqueName,
      };
    }

    const emailJob = await EmailJob.create({
      to,
      subject: method === "email" ? subject : undefined,
      body,
      datetime: scheduledTime,
      originalLocalTime: datetime,
      timezone,
      status: "scheduled",
      userId: req.user.uid,
      method,
      attachment: attachmentMeta,
    });

    if (emailQueue) {
      await emailQueue.add(
        "sendNotification",
        {
          method,
          to,
          subject,
          body,
          emailJobId: emailJob._id.toString(),
          attachment: attachmentMeta,
        },
        {
          id: emailJob._id.toString(),
          delay: delayMs,
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
        }
      );
    } else {
      // immediate send fallback
      let attachments = [];
      if (attachmentMeta?.objectName) {
        const fileRef = bucket.file(attachmentMeta.objectName);
        const [signedUrl] = await fileRef.getSignedUrl({
          action: "read",
          expires: Date.now() + 60 * 60 * 1000,
        });
        const resp = await fetch(signedUrl);
        const buffer = await resp.buffer();
        attachments = [
          { filename: attachmentMeta.filename, content: buffer },
        ];
      }
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text: body,
        attachments,
      });
    }

    const localTime = utcToZonedTime(scheduledTime, timezone);
    res.json({
      message: `✅ ${method.toUpperCase()} scheduled for ${format(
        localTime,
        "yyyy-MM-dd HH:mm:ss zzz",
        { timeZone: timezone }
      )}`,
      jobId: emailJob._id.toString(),
    });
  } catch (err) {
    console.error("❌ Schedule error:", err.message);
    res.status(500).json({ error: "❌ Server error: " + err.message });
  }
});

// ---------- Static ----------
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/schedule", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "schedule.html"))
);
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------- Logout ----------
app.post("/logout", authenticateFirebase, async (req, res) => {
  try {
    await admin.auth().revokeRefreshTokens(req.user.uid);
    res.json({ message: "✅ Logged out" });
  } catch (err) {
    res.status(500).json({ error: "❌ Log out failed" });
  }
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
