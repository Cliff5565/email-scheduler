// workers/emailWorker.js
import { Worker } from "bullmq";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// Redis options
const redisOptions = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

// Nodemailer transport (reuse EMAIL_USER + EMAIL_PASS)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const worker = new Worker(
  "emails",
  async (job) => {
    const { to, subject, body } = job.data;
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text: body,
    });
    console.log(`✅ Email sent to ${to}`);
  },
  { connection: redisOptions }
);

worker.on("failed", (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err);
});
