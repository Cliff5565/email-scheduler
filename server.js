// Use ES Module syntax, so make sure package.json has "type": "module"

import express from "express";
import nodemailer from "nodemailer";
import cron from "node-cron";

const app = express();
const port = process.env.PORT || 10000;

// Middleware
app.use(express.json());

// In-memory task store (replace with DB for production)
const scheduledTasks = [];

// Root route
app.get("/", (req, res) => {
  res.send("🚀 Email Scheduler backend is running!");
});

// Schedule email route
app.post("/schedule", (req, res) => {
  const { to, subject, message, scheduleTime } = req.body;

  if (!to || !subject || !message || !scheduleTime) {
    return res.status(400).send("❌ Missing required fields");
  }

  // Convert scheduleTime to Date
  const runAt = new Date(scheduleTime);
  if (isNaN(runAt.getTime())) {
    return res.status(400).send("❌ Invalid scheduleTime format");
  }

  // Calculate cron expression
  const minute = runAt.getMinutes();
  const hour = runAt.getHours();
  const day = runAt.getDate();
  const month = runAt.getMonth() + 1; // cron months are 1-12

  const cronExp = `${minute} ${hour} ${day} ${month} *`;

  console.log(`📅 Scheduling email at ${runAt} with cron: ${cronExp}`);

  // Store task
  const task = cron.schedule(cronExp, async () => {
    try {
      await sendEmail(to, subject, message);
      console.log(`✅ Email sent to ${to} at ${new Date().toISOString()}`);
    } catch (err) {
      console.error("❌ Error sending email:", err);
    }
  });

  scheduledTasks.push({ to, subject, message, scheduleTime, task });

  res.send(`✅ Email scheduled for ${runAt.toString()}`);
});

// Nodemailer transport
async function sendEmail(to, subject, text) {
  // ⚠️ Replace with your SMTP config or use environment variables
  let transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER, // set in Render Dashboard
      pass: process.env.EMAIL_PASS, // set in Render Dashboard
    },
  });

  return transporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject,
    text,
  });
}

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${port}`);
});
