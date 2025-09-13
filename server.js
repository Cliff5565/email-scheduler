import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import IORedis from "ioredis";

dotenv.config();

// Fix __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Database ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------- Redis Setup ----------
let emailQueue = null;
let redisClient = null;

if (process.env.REDIS_URL) {
  try {
    redisClient = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
    });

    redisClient.on('error', (err) => {
      console.error('❌ Redis connection error:', err.message);
    });

    redisClient.on('connect', () => {
      console.log('🟢 Connecting to Redis...');
    });

    redisClient.on('ready', () => {
      console.log('✅ Redis connection established');
    });

    emailQueue = new Queue("emails", { connection: redisClient });
    console.log("✅ BullMQ queue initialized");
  } catch (err) {
    console.error("❌ Failed to initialize Redis:", err.message);
  }
} else {
  console.warn("⚠️ No REDIS_URL set. Email scheduling via BullMQ is disabled.");
}

// ---------- Nodemailer Transport ----------
export const transporter = nodemailer.createTransport({
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
app.use(express.static(__dirname));

// ---------- Models ----------
const EmailJobSchema = new mongoose.Schema({
  to: String,
  subject: String,
  body: String,
  datetime: Date,
  originalLocalTime: String, // 👈 Store original local time for display
  timezone: String,
  status: { type: String, default: "scheduled" },
  sentAt: Date,
  error: String,
});
const EmailJob = mongoose.model("EmailJob", EmailJobSchema);

// ---------- Worker: Process queued emails (runs inside server.js) ----------
if (emailQueue) {
  console.log("🔍 Starting BullMQ worker...");

  emailQueue.on("failed", async (job, err) => {
    console.error(`❌ Job ${job.id} failed:`, err.message);
    try {
      await EmailJob.findByIdAndUpdate(job.id, {
        status: "failed",
        error: err.message,
      });
    } catch (dbErr) {
      console.error("❌ Failed to update job status in DB after failure:", dbErr.message);
    }
  });

  emailQueue.on("completed", async (job, result) => {
    console.log(`✅ Job ${job.id} completed:`, result);
    try {
      await EmailJob.findByIdAndUpdate(job.id, {
        status: "sent",
        sentAt: new Date(),
      });
    } catch (dbErr) {
      console.error("❌ Failed to update job status in DB after success:", dbErr.message);
    }
  });

  const worker = new Worker(
    "emails",
    async (job) => {
      const { to, subject, body } = job.data;
      console.log(`📧 [Worker] Sending email to ${to}...`);

      const info = await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text: body,
      });

      return { messageId: info.messageId };
    },
    {
      connection: emailQueue.connection,
      concurrency: 5,
      removeOnComplete: true,
      removeOnFail: false,
    }
  );

  worker.on("error", (err) => {
    console.error("🔴 Worker error:", err);
  });

  worker.on("ready", () => {
    console.log("🟢 BullMQ worker is now listening for jobs.");
  });

  worker.on("drained", () => {
    console.log("📦 All jobs processed — worker idle");
  });

  console.log("✅ BullMQ worker started inside server.js");
} else {
  console.warn("⚠️ Not starting BullMQ worker: Redis connection not available.");
}

// ---------- Routes ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/schedule", (req, res) => res.sendFile(path.join(__dirname, "schedule.html")));

// 👇 CORRECTED /schedule ROUTE — NO DUPLICATES, NO IMPORTS INSIDE ROUTE
app.post("/schedule", async (req, res) => {
  // 👇 DESTRUCTURE ONLY ONCE — THIS IS THE ONLY INSTANCE
  const { to, subject, body, datetime, timezone } = req.body;

  if (!to || !subject || !body || !datetime || !timezone) {
    return res.status(400).json({
      error: "❌ Missing required fields: to, subject, body, datetime, timezone",
    });
  }

  if (!Intl.supportedValuesOf("timeZone").includes(timezone)) {
    return res.status(400).json({ error: "❌ Invalid timezone" });
  }

  // 👇 Import date-fns-tz using require() — NOT at top, but here where needed
  const { zonedTimeToUtc } = require('date-fns-tz');

  let scheduledTime;
  try {
    scheduledTime = zonedTimeToUtc(datetime, timezone); // Converts local time → UTC
  } catch (err) {
    return res.status(400).json({ error: "❌ Invalid date/time format" });
  }

  const now = Date.now();
  const delayMs = scheduledTime.getTime() - now;

  if (delayMs < 0) {
    return res.status(400).json({ error: "❌ Cannot schedule email in the past." });
  }

  const emailJob = await EmailJob.create({
    to,
    subject,
    body,
    datetime: scheduledTime,         // Stored as UTC (for scheduling)
    originalLocalTime: datetime,     // Stored as original local string (e.g., "2025-04-05T14:30")
    timezone,
    status: "scheduled",
  });

  if (emailQueue) {
    await emailQueue.add(
      "sendEmail",
      { to, subject, body },
      {
        id: emailJob._id.toString(),
        delay: delayMs,
      }
    );
    console.log(`📅 Scheduled job ${emailJob._id} for ${scheduledTime.toLocaleString()} (${timezone})`);
  } else {
    console.warn("⚠️ Redis not available, sending email immediately...");
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text: body,
      });
      await EmailJob.findByIdAndUpdate(emailJob._id, {
        status: "sent",
        sentAt: new Date(),
      });
      console.log(`✅ Sent email immediately to ${to}`);
    } catch (err) {
      await EmailJob.findByIdAndUpdate(emailJob._id, {
        status: "failed",
        error: err.message,
      });
      return res.status(500).json({ error: "❌ Failed to send email immediately" });
    }
  }

  res.json({
    message: `✅ Email scheduled for ${scheduledTime.toLocaleString()} (${timezone})`,
    jobId: emailJob._id.toString(),
  });
});

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down server...");
  if (redisClient) await redisClient.quit();
  process.exit(0);
});
