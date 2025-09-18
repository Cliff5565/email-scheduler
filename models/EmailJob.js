import mongoose from "mongoose";

const emailJobSchema = new mongoose.Schema({
  to: { type: String, required: true },
  subject: { type: String },
  body: { type: String, required: true },
  datetime: { type: Date, required: true },
  originalLocalTime: { type: String, required: true },
  timezone: { type: String, required: true },
  status: { type: String, enum: ["scheduled", "sent", "failed"], default: "scheduled" },
  userId: { type: String, required: true },
  method: { type: String, enum: ["email", "sms"], default: "email" },
  attachment: {
    filename: { type: String },
    downloadURL: { type: String }
  },
  sentAt: { type: Date },
  error: { type: String }
});

export const EmailJob = mongoose.model("EmailJob", emailJobSchema);
