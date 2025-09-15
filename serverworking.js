import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import IORedis from "ioredis";
import { zonedTimeToUtc } from "date-fns-tz";
import { EmailJob } from "./models/EmailJob.js";
import admin from "firebase-admin";

// ---------- Setup ----------
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

if (process.env.REDIS_URL) {
  redisClient = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });

  redisClient.on("error", (err) =>
    console.error("❌ Redis error:", err.message)
  );
  redisClient.on("ready", () => console.log("✅ Redis connected"));

  emailQueue = new Queue("emails", { connection: redisClient });
  console.log("✅ Queue initialized");

  // ---------- Worker in same server ----------
  new Worker(
    "emails",
    async (job) => {
      console.log("📧 Processing job:", job.id, job.data);
      const { to, subject, body, emailJobId } = job.data;

      try {
        const info = await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to,
          subject,
          text: body,
        });
        console.log("✅ Email sent (job):", info.messageId);
        if (emailJobId) {
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "sent",
            sentAt: new Date(),
          });
        }
      } catch (err) {
        console.error("❌ Email failed (job):", err.message);
        if (emailJobId) {
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "failed",
            error: err.message,
          });
        }
        throw err; // retry via BullMQ
      }
    },
    { connection: redisClient }
  );
} else {
  console.warn("⚠️ REDIS_URL not set — jobs will send immediately");
}

// ---------- Nodemailer ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Static pages ----------
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/schedule", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "schedule.html"))
);
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------- Auth ----------
async function authenticateFirebase(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "❌ Unauthorized: No token" });
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

// ---------- Schedule route ----------
app.post("/schedule", authenticateFirebase, async (req, res) => {
  const { to, subject, body, datetime, timezone } = req.body;
  if (!to || !subject || !body || !datetime || !timezone) {
    return res.status(400).json({ error: "❌ Missing fields" });
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

  const emailJob = await EmailJob.create({
    to,
    subject,
    body,
    datetime: scheduledTime,
    originalLocalTime: datetime,
    timezone,
    status: "scheduled",
    userId: req.user.uid,
  });

  if (emailQueue) {
    try {
      await emailQueue.add(
        "sendEmail",
        { to, subject, body, emailJobId: emailJob._id.toString() },
        {
          id: emailJob._id.toString(),
          delay: delayMs,
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
        }
      );
      return res.json({
        message: `✅ Email scheduled for ${scheduledTime.toLocaleString()} (${timezone})`,
        jobId: emailJob._id.toString(),
      });
    } catch (err) {
      console.error("❌ Queue failed:", err.message);
    }
  }

  // Fallback: send immediately
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text: body,
    });
    console.log("✅ Fallback email sent:", info.messageId);
    await EmailJob.findByIdAndUpdate(emailJob._id, {
      status: "sent",
      sentAt: new Date(),
    });
    return res.json({
      message: "✅ Email sent immediately (fallback)",
      jobId: emailJob._id.toString(),
    });
  } catch (err) {
    console.error("❌ Fallback failed:", err.message);
    await EmailJob.findByIdAndUpdate(emailJob._id, {
      status: "failed",
      error: err.message,
    });
    return res.status(500).json({ error: "❌ Failed to send: " + err.message });
  }
});

// ---------- Logout ----------
app.post("/logout", authenticateFirebase, (req, res) => {
  console.log(`👤 User ${req.user.uid} logged out`);
  res.json({ message: "✅ Logged out" });
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
