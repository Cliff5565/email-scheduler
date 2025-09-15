// models/EmailJob.js
import mongoose from "mongoose";

const EmailJobSchema = new mongoose.Schema({
  to: { type: String, required: true },
  subject: String,
  body: { type: String, required: true },
  datetime: { type: Date, required: true },
  originalLocalTime: String,
  timezone: String,
  method: { type: String, enum: ["email", "sms"], default: "email" },
  status: { type: String, enum: ["scheduled", "sent", "failed"], default: "scheduled" },
  userId: { type: String, required: true },
  sentAt: Date,
  error: String,
  attachment: {
    filename: String,
    path: String,
  },
});

export const EmailJob = mongoose.model("EmailJob", EmailJobSchema);