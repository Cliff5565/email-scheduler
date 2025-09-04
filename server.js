const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { Queue, Worker } = require("bullmq");
const Redis = require("ioredis");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const chalk = require("chalk");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Multer for uploads (Render ephemeral disk)
const upload = multer({ dest: "uploads/" });

// Redis connection (Upstash)
const redisConnection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: { rejectUnauthorized: false },
});

// BullMQ queue
const emailQueue = new Queue("emails", { connection: redisConnection });

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// Worker: process queued emails
new Worker(
  "emails",
  async (job) => {
    const { to, subject, text, html, attachments } = job.data;

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      text,
      html,
      attachments,
    });

    console.log(chalk.greenBright(`✅ Email sent to: ${to}`));

    // Auto-delete uploaded files
    if (attachments && attachments.length > 0) {
      attachments.forEach((file) => {
        if (file.path) {
          fs.unlink(file.path, (err) => {
            if (err) console.error(chalk.red(`❌ Failed to delete file: ${file.path}`), err);
            else console.log(chalk.yellow(`🗑️ Deleted file: ${file.path}`));
          });
        }
      });
    }
  },
  { connection: redisConnection }
);

// API: Schedule email
app.post("/schedule-email", upload.array("attachments"), async (req, res) => {
  try {
    const { to, subject, text, html, dateTime } = req.body;
    const delay = new Date(dateTime).getTime() - Date.now();

    if (isNaN(delay) || delay < 0) {
      console.log(chalk.red("❌ Invalid dateTime received"));
      return res.status(400).json({ message: "dateTime must be in the future" });
    }

    const attachments = (req.files || []).map((file) => ({
      filename: file.originalname,
      path: path.resolve(file.path),
    }));

    const job = await emailQueue.add(
      "sendEmail",
      { to, subject, text, html, attachments },
      { delay }
    );

    console.log(chalk.blue(`📩 Job queued for: ${to}, ID: ${job.id}, delay: ${delay}ms`));

    res.json({ message: "Email scheduled successfully", jobId: job.id });
  } catch (err) {
    console.error(chalk.red("❌ Error scheduling email:"), err);
    res.status(500).json({ error: err.message });
  }
});

// API: Check job status
app.get("/job-status/:id", async (req, res) => {
  const job = await emailQueue.getJob(req.params.id);
  if (!job) {
    console.log(chalk.gray(`Job not found: ${req.params.id}`));
    return res.status(404).json({ status: "not found" });
  }

  const state = await job.getState();
  console.log(chalk.cyan(`ℹ️ Job ${req.params.id} status: ${state}`));

  res.json({ status: state });
});

// Health check
app.get("/", (req, res) => {
  res.send("🚀 Email Scheduler backend is running!");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(chalk.magentaBright(`🚀 Server running on port ${PORT}`));
});
