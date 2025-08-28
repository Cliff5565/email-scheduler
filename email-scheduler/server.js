const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { Queue, Worker } = require("bullmq");
const Redis = require("ioredis");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Multer setup for file uploads
const upload = multer({ dest: "uploads/" });

// Redis options
const redisOptions = { maxRetriesPerRequest: null };

// BullMQ queue
const emailQueue = new Queue("emails", {
  connection: new Redis(redisOptions),
});

// Nodemailer transporter (use your Gmail + App Password)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "futurepostmannumberone@gmail.com", // your Gmail
    pass: "zdhaxtaywbrluufq",                 // your App Password
  },
});

// Worker: send emails when job runs
new Worker(
  "emails",
  async (job) => {
    const { to, subject, text, html, attachments } = job.data;

    await transporter.sendMail({
      from: "futurepostmannumberone@gmail.com", // must match your Gmail
      to,
      subject,
      text,
      html,
      attachments,
    });

    console.log("Email sent to:", to);

    // Auto-delete uploaded files
    if (attachments && attachments.length > 0) {
      attachments.forEach((file) => {
        if (file.path) {
          fs.unlink(file.path, (err) => {
            if (err) console.error("Failed to delete file:", file.path, err);
            else console.log("Deleted file:", file.path);
          });
        }
      });
    }
  },
  { connection: new Redis(redisOptions) }
);

// API: Schedule email
app.post("/schedule-email", upload.array("attachments"), async (req, res) => {
  const { to, subject, text, html, dateTime } = req.body;

  const delay = new Date(dateTime).getTime() - Date.now();
  if (delay < 0) {
    return res.status(400).json({ message: "Date/time must be in the future" });
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

  res.json({ message: "Email scheduled successfully", jobId: job.id });
});

// API: Check job status
app.get("/job-status/:id", async (req, res) => {
  const job = await emailQueue.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ status: "not found" });
  }
  const state = await job.getState(); // "waiting", "delayed", "active", "completed", "failed"
  res.json({ status: state });
});

// Start server
app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});