// src/models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true },
  displayName: String,
  email: String,
});

const User = mongoose.model("User", userSchema);
export default User;
