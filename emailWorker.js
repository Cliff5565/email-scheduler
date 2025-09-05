// workers/emailWorker.js
import nodemailer from "nodemailer";
import { Worker } from "bullmq";
import mongoose from "mongoose";
import Email from "../models/Email.js";

mongoose.connect(process.env.MONGO_URI);

const worker = new Worker("emails", async job => {
  const { to, subject, message, emailId } = job.data;

  let transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text: message });

  await Email.findByIdAndUpdate(emailId, { status: "SENT", sentAt: new Date() });
  console.log(`✅ Email sent to ${to}`);
});
