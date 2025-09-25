// server.js
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

  emailQueue = new Queue("notifications", { connection: redisClient });
  console.log("✅ Queue initialized");

  // ---------- Worker ----------
  new Worker(
    "notifications",
    async (job) => {
      console.log("📧/📱 Processing job:", job.id, job.data);
      const { method, to, subject, body, emailJobId, attachment } = job.data;

      try {
        if (method === "email") {
          const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to,
            subject,
            text: body,
            attachments: attachment ? [attachment] : [],
          });
          console.log("✅ Email sent (job):", info.messageId);
        } else if (method === "sms") {
          // ⚠️ Integrate Twilio or similar here
          console.log(`📱 Mock SMS sent to ${to}: ${body}`);
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
        throw err; // let BullMQ retry
      }
    },
    { connection: redisClient }
  );
} else {
  console.warn("⚠️ REDIS_URL not set — notifications will send immediately");
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

// ---------- File Upload ----------
const upload = multer({ dest: path.join(__dirname, "uploads/") });

// ---------- Auth middleware ----------
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

// ---------- API: Schedule Notification ----------
app.post(
  "/api/schedule",
  authenticateFirebase,
  upload.single("file"),
  async (req, res) => {
    try {
      const data = req.body.data ? JSON.parse(req.body.data) : req.body;
      const { to, subject, body, datetime, timezone, method = "email" } = data;

      if (!to || !body || !datetime || !timezone) {
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

      const attachment =
        req.file && method === "email"
          ? { filename: req.file.originalname, path: req.file.path }
          : undefined;

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
        attachment,
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
            attachment,
          },
          {
            id: emailJob._id.toString(),
            delay: delayMs,
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
          }
        );
      } else {
        // fallback immediate send
        if (method === "email") {
          await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to,
            subject,
            text: body,
            attachments: attachment ? [attachment] : [],
          });
        }
      }

      const localTime = utcToZonedTime(scheduledTime, timezone);
      return res.json({
        message: `✅ ${method.toUpperCase()} scheduled for ${format(
          localTime,
          "yyyy-MM-dd HH:mm:ss zzz",
          { timeZone: timezone }
        )}`,
        jobId: emailJob._id.toString(),
      });
    } catch (err) {
      console.error("❌ Schedule error:", err.message);
      return res.status(500).json({ error: "❌ Server error: " + err.message });
    }
  }
);

// ---------- API: Logout ----------
app.post("/api/logout", authenticateFirebase, async (req, res) => {
  try {
    await admin.auth().revokeRefreshTokens(req.user.uid);
    console.log(`👤 User ${req.user.uid} logged out and tokens revoked`);
    res.json({ message: "✅ Logged out (tokens revoked)" });
  } catch (err) {
    console.error("❌ Logout error:", err.message);
    res.status(500).json({ error: "❌ Failed to logout" });
  }
});

// ---------- Static pages ----------
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/schedule", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "schedule.html"))
);
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------- Global Error Handler ----------
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  if (req.path.startsWith("/api")) {
    res.status(500).json({ error: "❌ Unexpected server error" });
  } else {
    res.status(500).send("Internal Server Error");
  }
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
