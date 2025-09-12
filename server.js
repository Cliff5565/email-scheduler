// server.js
import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue } from "bullmq";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import { createClient } from "redis";

dotenv.config();

// Fix __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Database ----------
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/email_scheduler")
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------- Redis ----------
const redisConnection = {
  connection: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: process.env.REDIS_PORT || 6379,
  },
};

const emailQueue = new Queue("emails", redisConnection);

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Serve static files ----------
app.use(express.static(__dirname));

// ---------- Models ----------
const EmailJobSchema = new mongoose.Schema({
  to: String,
  subject: String,
  body: String,
  datetime: Date,
  status: { type: String, default: "scheduled" },
});

const EmailJob = mongoose.model("EmailJob", EmailJobSchema);

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/schedule", (req, res) => {
  res.sendFile(path.join(__dirname, "schedule.html"));
});

app.post("/schedule", async (req, res) => {
  const { to, subject, body, datetime } = req.body;
  try {
    // Store job in DB
    const job = await EmailJob.create({ to, subject, body, datetime });

    // Push into Redis queue
    await emailQueue.add(
      "sendEmail",
      { to, subject, body },
      { delay: new Date(datetime).getTime() - Date.now() }
    );

    console.log(`📅 Scheduled email to ${to} at ${datetime}`);
    res.send(`✅ Email scheduled for ${datetime}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to schedule email");
  }
});

// ---------- Nodemailer transport ----------
export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
