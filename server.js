import express from "express";
import nodemailer from "nodemailer";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const port = process.env.PORT || 10000;

// Helpers to serve HTML files
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // for <form> submissions
app.use(express.static(dirname)); // serve static files like schedule.html

// Root route
app.get("/", (req, res) => {
  res.send("🚀 Email Scheduler backend is running!");
});

// POST /schedule
app.post("/schedule", (req, res) => {
  const { to, subject, message, scheduleTime } = req.body;

  if (!to || !subject || !message || !scheduleTime) {
    return res.status(400).send("❌ Missing required fields");
  }

  const runAt = new Date(scheduleTime);
  if (isNaN(runAt.getTime())) {
    return res.status(400).send("❌ Invalid date/time format");
  }

  // Build cron expression
  const minute = runAt.getMinutes();
  const hour = runAt.getHours();
  const day = runAt.getDate();
  const month = runAt.getMonth() + 1; // Months are 0-based
  const cronExp = `${minute} ${hour} ${day} ${month} *`;
  console.log(`📅 Scheduling email to ${to} at ${runAt} with cron: ${cronExp}`);

  // Schedule task
  cron.schedule(cronExp, async () => {
    try {
      await sendEmail(to, subject, message);
      console.log(`✅ Email sent to ${to} at ${new Date().toISOString()}`);
    } catch (err) {
      console.error("❌ Failed to send email:", err);
    }
  });

  res.send(`✅ Email scheduled for ${runAt.toString()}`);
});

// Nodemailer transport
async function sendEmail(to, subject, text) {
  let transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER, // set in Render
      pass: process.env.EMAIL_PASS  // set in Render
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
