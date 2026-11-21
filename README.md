# Cortex S3 AI — Web Companion App ⚡

Web Bluetooth & Multimodal AI Companion application for the **Cortex S3 AI Smartwatch** (powered by Seeed Studio XIAO ESP32-S3 Sense).

🔗 **Live Web App:** [https://sumitrawat2417.github.io/cortex-s3-ai-app/](https://sumitrawat2417.github.io/cortex-s3-ai-app/)  
🔗 **Hardware & Firmware Repo:** [https://github.com/sumitrawat2417/cortex-s3-ai](https://github.com/sumitrawat2417/cortex-s3-ai)

---

## Features

- 📡 **Web Bluetooth (BLE) Interface**: Connects directly to the XIAO ESP32-S3 over low-latency GATT characteristics.
- 👁️🎙️ **Look & Ask Multimodal AI**: Streams captured photos from the OV2640 camera and voice audio from the PDM mic over BLE to Groq Vision + Whisper STT.
- 💬 **Instant Display Response**: Streams AI answers directly back to the watch's ST7789 IPS LCD with chunked MTU flow control.
- 📸 **Camera Live Preview & Snap**: Review snapped frames, adjust camera rotation, and download photos.
- 🎙️ **Voice AI**: Record and ask questions through the watch's digital microphone with instant Groq LLM answers.
- ⏰ **Clock, Timer & Notification Sync**: Syncs device time, alarms, and notifications seamlessly.

---

## Browser Requirements

This application relies on the **Web Bluetooth API** and requires an **HTTPS** environment (provided automatically by GitHub Pages):
- **Desktop**: Google Chrome, Microsoft Edge, or Chromium (Windows, macOS, Linux, ChromeOS)
- **Mobile**: Google Chrome for Android or Bluefy Browser for iOS

---

## Development

```bash
# Install dependencies
npm install

# Start local dev server
npm run dev

# Build production bundle
npm run build
```
