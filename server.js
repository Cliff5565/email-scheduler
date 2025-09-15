import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue } from "bullmq";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import IORedis from "ioredis";
import { zonedTimeToUtc } from "date-fns-tz";
import { EmailJob } from "./models/EmailJob.js";
import admin from "firebase-admin";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Validate Required Env Vars ----------
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
  console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// ---------- Initialize Firebase Admin SDK ----------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}
console.log("✅ Firebase Admin initialized");

// ---------- MongoDB ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected (server)"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------- Redis (Producer) ----------
let emailQueue = null;
let redisClient = null;

if (process.env.REDIS_URL) {
  redisClient = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });

  redisClient.on("error", (err) =>
    console.error("❌ Redis connection error:", err.message)
  );
  redisClient.on("ready", () => console.log("✅ Redis connected (server)"));

  emailQueue = new Queue("emails", { connection: redisClient });
  console.log("✅ BullMQ queue initialized (server)");
} else {
  console.warn("⚠️ REDIS_URL not set — scheduling disabled");
}

// ---------- Fallback mail transport ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 👇 EXPLICIT ROUTES FIRST — BEFORE STATIC FILES
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/schedule", (req, res) => res.sendFile(path.join(__dirname, "public", "schedule.html")));

// 👇 Serve static assets (JS, CSS, images) — but NOT HTML pages
app.use(express.static(path.join(__dirname, "public"), {
  index: false, // Prevent auto-serving index.html for folders
}));

// ---------- Authentication Middleware ----------
async function authenticateFirebase(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "❌ Unauthorized: No token provided" });
  }

  const idToken = authHeader.substring(7);

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Attach user info to request
    next();
  } catch (err) {
    console.error("❌ Invalid Firebase ID token:", err);
    return res.status(401).json({ error: "❌ Invalid or expired authentication token" });
  }
}

// ---------- Protected Route ----------
app.post("/schedule", authenticateFirebase, async (req, res) => {
  const { to, subject, body, datetime, timezone } = req.body;

  if (!to || !subject || !body || !datetime || !timezone) {
    return res.status(400).json({ error: "❌ Missing required fields" });
  }

  if (!Intl.supportedValuesOf("timeZone").includes(timezone)) {
    return res.status(400).json({ error: "❌ Invalid timezone" });
  }

  let scheduledTime;
  try {
    scheduledTime = zonedTimeToUtc(datetime, timezone);
  } catch {
    return res.status(400).json({ error: "❌ Invalid date/time format" });
  }

  const delayMs = scheduledTime.getTime() - Date.now();
  if (delayMs < 0) {
    return res.status(400).json({ error: "❌ Cannot schedule email in the past" });
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

  // 👇 NEW: Try to add to Redis queue — if it fails, FALL BACK IMMEDIATELY
  if (emailQueue) {
    try {
      await emailQueue.add(
        "sendEmail",
        { to, subject, body },
        {
          id: emailJob._id.toString(),
          delay: delayMs,
        }
      );
      console.log(`📅 Scheduled job ${emailJob._id} for ${scheduledTime} by user: ${req.user.uid}`);
      return res.json({
        message: `✅ Email scheduled for ${scheduledTime.toLocaleString()} (${timezone})`,
        jobId: emailJob._id.toString(),
      });
    } catch (err) {
      console.error("❌ BullMQ queue failed (ECONNRESET/EPIPE), falling back to immediate send:", err.message);
      // 👇 FALL THROUGH TO Fallback Block
    }
  }

  // 👇 FALLBACK: Send immediately via Nodemailer (always runs if Redis fails or is absent)
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text: body,
    });
    console.log("✅ Fallback email sent successfully:", info.messageId); // 👈 CRITICAL LOG
    await EmailJob.findByIdAndUpdate(emailJob._id, {
      status: "sent",
      sentAt: new Date(),
    });
    res.json({
      message: `✅ Email sent immediately to ${to}`,
      jobId: emailJob._id.toString(),
    });
  } catch (err) {
    console.error("❌ Fallback email FAILED (Nodemailer):", err.message); // 👈 CRITICAL LOG
    await EmailJob.findByIdAndUpdate(emailJob._id, {
      status: "failed",
      error: err.message,
    });
    return res.status(500).json({ error: "❌ Failed to send immediately: " + err.message });
  }
});

// ---------- Logout Route (Optional but recommended) ----------
app.post("/logout", authenticateFirebase, async (req, res) => {
  console.log(`👤 User ${req.user.uid} logged out`);
  res.json({ message: "✅ Logged out successfully" });
});

// ---------- Start Server ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

process.on("SIGINT", async () => {
  if (redisClient) await redisClient.quit();
  process.exit(0);
});
