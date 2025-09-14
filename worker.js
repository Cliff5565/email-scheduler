import dotenv from "dotenv";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { EmailJob } from "./models/EmailJob.js";

dotenv.config();

// ---------- MongoDB ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Worker connected to MongoDB"))
  .catch((err) => console.error("❌ Worker MongoDB error:", err));

// ---------- Redis ----------
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
});

connection.on("ready", () => console.log("✅ Worker connected to Redis"));

// ---------- Mailer ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ---------- Worker ----------
const worker = new Worker(
  "emails",
  async (job) => {
    console.log(`📧 Worker: processing job.id=${job.id}, sending to ${job.data.to}`);

    const { to, subject, body } = job.data;

    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text: body,
    });

    // ✅ job.id matches Mongo _id string
    await EmailJob.findByIdAndUpdate(job.id, {
      status: "sent",
      sentAt: new Date(),
    });

    return { messageId: info.messageId };
  },
  { connection, concurrency: 5 }
);

// ---------- Events ----------
worker.on("active", (job) => {
  console.log(`🔎 Worker started job.id=${job.id}`);
});

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on("failed", async (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err.message);
  if (job) {
    await EmailJob.findByIdAndUpdate(job.id, {
      status: "failed",
      error: err.message,
    });
  }
});
