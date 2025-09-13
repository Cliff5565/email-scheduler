import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq"; // 👈 FIXED: Added Worker here
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

// ---------- Redis & BullMQ Queue ----------
let emailQueue = null;

if (process.env.REDIS_URL) {
  try {
    const redisClient = new IORedis(process.env.REDIS_URL, {
      tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
    });
    emailQueue = new Queue("emails", { connection: redisClient });
    console.log("✅ Connected to Redis and BullMQ queue ready");
  } catch (err) {
    console.error("❌ Failed to connect to Redis:", err.message);
  }
} else {
  console.warn("⚠️ No REDIS_URL set. Email scheduling via BullMQ is disabled.");
}

// ---------- Nodemailer Transport ----------
export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); // serve static files (HTML, CSS, JS)

// ---------- Models ----------
const EmailJobSchema = new mongoose.Schema({
  to: String,
  subject: String,
  body: String,
  datetime: Date,
  status: { type: String, default: "scheduled" },
  sentAt: Date,
  error: String,
});
const EmailJob = mongoose.model("EmailJob", EmailJobSchema);

// ---------- Worker: Process queued emails (run this once!) ----------
// ⚠️ IMPORTANT: This worker should run in a separate process or as a background task.
// But for simplicity in single-server deployment, we'll start it here.
// In production, use a dedicated worker script (e.g., worker.js).
if (emailQueue) {
  emailQueue.on("failed", async (job, err) => {
    console.error(`❌ Job ${job.id} failed:`, err.message);
    await EmailJob.findByIdAndUpdate(job.id, {
      status: "failed",
      error: err.message,
    });
  });

  emailQueue.on("completed", async (job, result) => {
    console.log(`✅ Job ${job.id} completed:`, result);
    await EmailJob.findByIdAndUpdate(job.id, {
      status: "sent",
      sentAt: new Date(),
    });
  });

  // Define the worker logic
  const worker = new Worker(
    "emails",
    async (job) => {
      const { to, subject, body } = job.data;
      console.log(`📧 Sending email to ${to}...`);

      const info = await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text: body,
      });

      return { messageId: info.messageId };
    },
    { connection: emailQueue.connection }
  );

  worker.on("error", (err) => {
    console.error("❌ Worker error:", err);
  });

  console.log("✅ BullMQ worker started for 'emails' queue");
}

// ---------- Routes ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/schedule", (req, res) => res.sendFile(path.join(__dirname, "schedule.html")));

app.post("/schedule", async (req, res) => {
  const { to, subject, body, datetime } = req.body;

  if (!to || !subject || !body || !datetime) {
    return res.status(400).json({ error: "❌ Missing required fields: to, subject, body, datetime" });
  }

  const scheduledTime = new Date(datetime);
  if (isNaN(scheduledTime.getTime())) {
    return res.status(400).json({ error: "❌ Invalid date/time format" });
  }

  try {
    // Save to MongoDB for persistence and tracking
    const emailJob = await EmailJob.create({ to, subject, body, datetime });

    if (emailQueue) {
      // Add job to BullMQ with delay
      await emailQueue.add(
        "sendEmail",
        { to, subject, body },
        {
          id: emailJob._id.toString(), // Use MongoDB ID as job ID for tracking
          delay: scheduledTime.getTime() - Date.now(), // Delay in ms
        }
      );
      console.log(`📅 Scheduled email job ${emailJob._id} for ${scheduledTime}`);
    } else {
      // Fallback: Send immediately if Redis is down
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
      message: `✅ Email scheduled for ${scheduledTime.toLocaleString()}`,
      jobId: emailJob._id.toString(),
    });
  } catch (err) {
    console.error("❌ Error scheduling email:", err);
    res.status(500).json({ error: "❌ Failed to schedule email" });
  }
});

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
