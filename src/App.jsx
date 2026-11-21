import React, { useState, useEffect, useRef } from 'react';
import { 
  Bluetooth, BluetoothConnected, BluetoothOff, Mic, Camera, Sparkles, 
  Volume2, VolumeX, Settings, Zap, ShieldCheck, Play, Pause, RefreshCw, X, Download,
  Send, HelpCircle, ArrowRight, RotateCw, Eye
} from 'lucide-react';
import { SERVICE_UUID, CHAR_STREAM_UUID, CHAR_CMD_UUID, pcmToWavBlob, blobToBase64 } from './utils/ble';
import { transcribeWithGroq, askGroqLLM, askGroqVision, classifyCommandWithLLM } from './utils/groq';
import './App.css';

const DEFAULT_GROQ_KEY = '';

// Helper to rotate JPEG blob in-browser via offscreen canvas
function rotateImageBlob(blob, angleDegrees) {
  return new Promise((resolve) => {
    if (angleDegrees === 0) {
      resolve({ blob, url: URL.createObjectURL(blob), width: 240, height: 240 });
      return;
    }
    const img = new Image();
    const tempUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(tempUrl);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const rad = (angleDegrees * Math.PI) / 180;
      if (angleDegrees === 90 || angleDegrees === 270) {
        canvas.width = img.height;
        canvas.height = img.width;
      } else {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      canvas.toBlob((rotatedBlob) => {
        resolve({
          blob: rotatedBlob,
          url: URL.createObjectURL(rotatedBlob),
          width: canvas.width,
          height: canvas.height
        });
      }, 'image/jpeg', 0.95);
    };
    img.src = tempUrl;
  });
}

export default function App() {
  const [bleDevice, setBleDevice] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [statusText, setStatusText] = useState('Connect your XIAO Watch via Bluetooth to begin');
  const [appState, setAppState] = useState('idle'); // idle | ble_transfer | photo_review | transcribing | thinking | answered

  // Active Photo (Review State)
  const [activePhotoBlob, setActivePhotoBlob] = useState(null);
  const [activePhotoUrl, setActivePhotoUrl] = useState(null);
  const [photoMeta, setPhotoMeta] = useState(null); // { sizeKb, width, height, bleMs }
  const [customVisionPrompt, setCustomVisionPrompt] = useState('Read and extract all visible text from this image, then explain or answer clearly.');
  const [watchRotation, setWatchRotation] = useState(90); // Default to 90° to match watch camera
  const [autoProceedVision, setAutoProceedVision] = useState(true); // Auto-send to AI when user taps D1 on watch
  const [ttsEnabled, setTtsEnabled] = useState(true); // Text-To-Speech for AI responses

  // Active Audio
  const [activeAudioUrl, setActiveAudioUrl] = useState(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  // Transfer & Feed
  const [bleProgress, setBleProgress] = useState(0);
  const [chatHistory, setChatHistory] = useState([]);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('groq_api_key') || import.meta.env.VITE_GROQ_API_KEY || DEFAULT_GROQ_KEY);
  const [showSettings, setShowSettings] = useState(false);

  // BLE & Look-and-Ask References
  const cmdCharRef = useRef(null);
  const streamChunksRef = useRef([]);
  const expectedBytesRef = useRef(0);
  const sampleRateRef = useRef(8000);
  const transferStartRef = useRef(0);
  const transferTypeRef = useRef(null); // 'audio' | 'image'
  const photoMetaRef = useRef({ width: 640, height: 480 });
  const audioPlayerRef = useRef(new Audio());
  const isLookAndAskRef = useRef(false);
  const pendingPhotoRef = useRef(null); // { blob, url, meta, bleMs }

  useEffect(() => {
    localStorage.setItem('groq_api_key', apiKey);
  }, [apiKey]);

  // Text-to-Speech (TTS) disabled per user request
  function speakText(text) {
    // Disabled (answers shown on smartwatch screen)
  }

  // -----------------------------------------------------------
  // Bluetooth Connection (Web Bluetooth API)
  // -----------------------------------------------------------
  async function connectBluetooth() {
    if (!navigator.bluetooth) {
      alert('Web Bluetooth is not supported in this browser. Please use Google Chrome or Microsoft Edge on Windows, Mac, or Android!');
      return;
    }

    try {
      setIsConnecting(true);
      setStatusText('Scanning for XIAO-AI-Watch...');

      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { name: 'Cortex S3 AI' },
          { name: 'XIAO-AI-Watch' }
        ],
        optionalServices: [SERVICE_UUID]
      });

      device.addEventListener('gattserverdisconnected', onDisconnected);
      setBleDevice(device);

      setStatusText('Connecting to GATT Server...');
      const server = await device.gatt.connect();

      setStatusText('Discovering Multimodal Service...');
      const service = await server.getPrimaryService(SERVICE_UUID);

      // Stream Characteristic (Audio & Images)
      const streamChar = await service.getCharacteristic(CHAR_STREAM_UUID);
      await streamChar.startNotifications();
      streamChar.addEventListener('characteristicvaluechanged', handleStreamPacket);

      // Command Characteristic (Write)
      const cmdChar = await service.getCharacteristic(CHAR_CMD_UUID);
      cmdCharRef.current = cmdChar;

      setIsConnected(true);
      setIsConnecting(false);
      setStatusText('Connected to XIAO Watch! Ready.');
    } catch (err) {
      console.error(err);
      setIsConnecting(false);
      setStatusText(err.name === 'NotFoundError' ? 'Pairing cancelled' : `Connection error: ${err.message}`);
    }
  }

  function onDisconnected() {
    setIsConnected(false);
    cmdCharRef.current = null;
    setStatusText('Watch disconnected. Re-connect when ready.');
  }

  function disconnectBluetooth() {
    if (bleDevice && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
    }
    onDisconnected();
  }

  // -----------------------------------------------------------
  // Handle Incoming BLE Stream Packets (Lossless & Sequenced)
  // -----------------------------------------------------------
  function handleStreamPacket(event) {
    const value = event.target.value;
    if (value.byteLength === 0) return;

    const flag = value.getUint8(0);

    // --- AUDIO PROTOCOL (0x01: AI Voice, 0x05: Assistant Voice Control) ---
    if (flag === 0x01 || flag === 0x05) {
      transferTypeRef.current = (flag === 0x05) ? 'control_audio' : 'audio';
      streamChunksRef.current = [];
      expectedBytesRef.current = value.getUint32(1, true);
      sampleRateRef.current = value.getUint16(5, true) || 8000;
      transferStartRef.current = performance.now();

      setAppState('ble_transfer');
      setBleProgress(0);
      setStatusText(flag === 0x05
        ? '🎙️ Assistant Control: Receiving voice command...'
        : 'Receiving voice audio over BLE...');
    } 
    else if (flag === 0x02 && (transferTypeRef.current === 'audio' || transferTypeRef.current === 'control_audio')) {
      const chunk = new Uint8Array(value.buffer, value.byteOffset + 1, value.byteLength - 1);
      streamChunksRef.current.push(chunk);

      const currentBytes = streamChunksRef.current.reduce((acc, c) => acc + c.length, 0);
      if (expectedBytesRef.current > 0) {
        setBleProgress(Math.min(100, Math.round((currentBytes / expectedBytesRef.current) * 100)));
      }
    } 
    else if (flag === 0x03 && (transferTypeRef.current === 'audio' || transferTypeRef.current === 'control_audio')) {
      const bleMs = Math.round(performance.now() - transferStartRef.current);
      if (transferTypeRef.current === 'control_audio') {
        finishControlAudioTransfer(bleMs);
      } else {
        finishAudioTransfer(bleMs);
      }
    }

    // --- IMAGE PROTOCOL (0x11: Photo Only, 0x15: Look & Ask Photo + Voice to Follow) ---
    else if (flag === 0x11 || flag === 0x15) {
      isLookAndAskRef.current = (flag === 0x15);
      pendingPhotoRef.current = null;
      transferTypeRef.current = 'image';
      streamChunksRef.current = [];
      expectedBytesRef.current = value.getUint32(1, true);
      const width = value.getUint16(5, true);
      const height = value.getUint16(7, true);
      photoMetaRef.current = { width, height };
      transferStartRef.current = performance.now();

      // Immediately clear any previous photo
      clearActivePhoto();

      setAppState('ble_transfer');
      setBleProgress(0);
      setStatusText(flag === 0x15
        ? '👁️ Receiving Look & Ask photo over BLE...'
        : '📸 Receiving high-res photo over BLE...');
    }
    else if (flag === 0x12 && transferTypeRef.current === 'image') {
      // Chunk format: [0x12, seqLo, seqHi, payload...]
      if (value.byteLength > 3) {
        const seq = value.getUint16(1, true);
        const chunkData = new Uint8Array(value.buffer, value.byteOffset + 3, value.byteLength - 3);
        streamChunksRef.current.push({ seq, data: chunkData });

        const currentBytes = streamChunksRef.current.reduce((acc, c) => acc + c.data.length, 0);
        if (expectedBytesRef.current > 0) {
          setBleProgress(Math.min(100, Math.round((currentBytes / expectedBytesRef.current) * 100)));
        }
      }
    }
    else if (flag === 0x13 && transferTypeRef.current === 'image') {
      const bleMs = Math.round(performance.now() - transferStartRef.current);
      finishImageTransfer(bleMs);
    }
  }

  function clearActivePhoto() {
    if (activePhotoUrl) {
      URL.revokeObjectURL(activePhotoUrl);
      setActivePhotoUrl(null);
    }
    setActivePhotoBlob(null);
    setPhotoMeta(null);
    if (appState === 'photo_review') {
      setAppState('idle');
      setStatusText('Ready.');
    }
  }

  // -----------------------------------------------------------
  // Finish Image Transfer -> Enter Review Mode or Await Voice
  // -----------------------------------------------------------
  async function finishImageTransfer(bleTransferMs) {
    if (streamChunksRef.current.length === 0) {
      setAppState('idle');
      setStatusText('No image packets received.');
      return;
    }

    // Sort chunks by sequence index to guarantee zero packet transposition
    streamChunksRef.current.sort((a, b) => a.seq - b.seq);
    const sortedBuffers = streamChunksRef.current.map(c => c.data);
    const totalBytes = sortedBuffers.reduce((acc, c) => acc + c.length, 0);

    const rawBlob = new Blob(sortedBuffers, { type: 'image/jpeg' });
    
    // Auto-rotate by watch orientation so preview & AI input are upright!
    const { blob: rotatedBlob, url: imageUrl, width, height } = await rotateImageBlob(rawBlob, watchRotation);

    setActivePhotoBlob(rotatedBlob);
    setActivePhotoUrl(imageUrl);

    const sizeKb = (totalBytes / 1024).toFixed(1);
    const meta = {
      sizeKb,
      width: width || photoMetaRef.current.width,
      height: height || photoMetaRef.current.height,
      bleMs: bleTransferMs,
      totalBytes
    };
    setPhotoMeta(meta);

    // If this is a Look & Ask photo, hold it for the voice question arriving next!
    if (isLookAndAskRef.current) {
      pendingPhotoRef.current = {
        blob: rotatedBlob,
        url: imageUrl,
        meta,
        bleMs: bleTransferMs
      };
      setAppState('ble_transfer');
      setStatusText(`📸 Photo received (${sizeKb} KB). 🎙️ Receiving voice question over BLE...`);
      return;
    }

    // Normal standalone photo:
    if (autoProceedVision) {
      setStatusText(`📸 Photo confirmed from watch (${sizeKb} KB). Sending to Vision AI...`);
      proceedWithVisionAI(rotatedBlob, meta, imageUrl);
    } else {
      setAppState('photo_review');
      setStatusText(`📸 Photo captured (${sizeKb} KB in ${bleTransferMs} ms). Review below to proceed!`);
    }
  }

  async function rotateActivePhoto() {
    if (!activePhotoBlob) return;
    const { blob, url, width, height } = await rotateImageBlob(activePhotoBlob, 90);
    if (activePhotoUrl) URL.revokeObjectURL(activePhotoUrl);
    setActivePhotoBlob(blob);
    setActivePhotoUrl(url);
    if (photoMeta) {
      setPhotoMeta(prev => ({ ...prev, width, height }));
    }
  }

  async function changeWatchRotation(deg) {
    setWatchRotation(deg);
    if (cmdCharRef.current) {
      try {
        const encoder = new TextEncoder();
        await cmdCharRef.current.writeValue(encoder.encode(`ROT:${deg}`));
        setStatusText(`🔄 Watch live viewfinder rotation set to ${deg}°`);
      } catch (e) {
        console.warn('Could not set watch rotation:', e);
      }
    }
  }

  // -----------------------------------------------------------
  // Proceed with Vision AI (Called on watch confirm or manual click)
  // -----------------------------------------------------------
  async function proceedWithVisionAI(customBlob = null, customMeta = null, customUrl = null) {
    const blobToUse = customBlob || activePhotoBlob;
    const metaToUse = customMeta || photoMeta;
    const urlToUse = customUrl || activePhotoUrl;
    if (!blobToUse) return;

    setAppState('thinking');
    setStatusText('Sending image to Groq Vision AI (Qwen 27B)...');

    try {
      const base64Image = await blobToBase64(blobToUse);
      const promptToSend = customVisionPrompt && customVisionPrompt.trim().length > 0
        ? customVisionPrompt.trim()
        : 'Read and extract all visible text from this image, then explain or answer clearly.';

      const { answer, visionMs } = await askGroqVision(base64Image, promptToSend, apiKey);

      // Send answer snippet to watch
      await sendAnswerToWatch(answer);

      const totalMs = (metaToUse?.bleMs || 0) + visionMs;

      setChatHistory(prev => [
        {
          id: Date.now(),
          type: 'vision',
          imageUrl: urlToUse,
          imageMeta: metaToUse,
          question: promptToSend,
          answer,
          timing: { bleMs: metaToUse?.bleMs || 0, visionMs, totalMs },
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        },
        ...prev
      ]);

      setAppState('answered');
      setStatusText('Vision AI complete! Answer sent to watch.');
    } catch (err) {
      console.error(err);
      setAppState('photo_review');
      setStatusText(`Vision AI error: ${err.message}`);
    }
  }

  // -----------------------------------------------------------
  // Finish Audio Processing (Whisper STT + Groq LLM or Look & Ask Vision)
  // -----------------------------------------------------------
  async function finishAudioTransfer(bleTransferMs) {
    const totalBytes = streamChunksRef.current.reduce((acc, c) => acc + c.length, 0);
    if (totalBytes === 0) {
      setAppState('idle');
      setStatusText('No audio bytes received.');
      return;
    }

    const pcmBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of streamChunksRef.current) {
      pcmBytes.set(chunk, offset);
      offset += chunk.length;
    }

    const wavBlob = pcmToWavBlob(pcmBytes.buffer, sampleRateRef.current);
    const audioUrl = URL.createObjectURL(wavBlob);
    setActiveAudioUrl(audioUrl);

    setAppState('transcribing');
    setStatusText('Transcribing speech with Groq Whisper Large V3...');

    try {
      const { text: rawQuestion, sttMs } = await transcribeWithGroq(wavBlob, apiKey);
      const question = rawQuestion.trim();

      // Check if this audio belongs to a Look & Ask multimodal query OR references an active photo!
      const photoToUse = pendingPhotoRef.current || (activePhotoBlob ? {
        blob: activePhotoBlob,
        url: activePhotoUrl,
        meta: photoMeta,
        bleMs: 0
      } : null);

      const isVisionQuery = isLookAndAskRef.current || (photoToUse && (
        /image|photo|picture|look|see|object|this|read|what is (this|that)|flower|plant/i.test(question) || !question
      ));

      if (photoToUse && isVisionQuery) {
        const promptToSend = (question && question.length > 0 && !question.toLowerCase().includes('thank you'))
          ? question
          : 'Inspect this image carefully. What is this object? Explain concisely in 1-2 sentences.';

        setAppState('thinking');
        setStatusText(`👁️🎙️ Groq Vision answering: "${promptToSend}"...`);

        const base64Image = await blobToBase64(photoToUse.blob);
        const { answer, visionMs } = await askGroqVision(base64Image, promptToSend, apiKey);

        // Send answer to watch ST7789 display
        await sendAnswerToWatch(answer);

        const totalMs = photoToUse.bleMs + bleTransferMs + sttMs + visionMs;

        setChatHistory(prev => [
          {
            id: Date.now(),
            type: 'look_and_ask',
            question: promptToSend,
            answer,
            imageUrl: photoToUse.url,
            imageMeta: photoToUse.meta,
            audioUrl,
            timing: {
              blePhotoMs: photoToUse.bleMs,
              bleAudioMs: bleTransferMs,
              sttMs,
              visionMs,
              totalMs
            },
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          },
          ...prev
        ]);

        // Reset Look & Ask references
        isLookAndAskRef.current = false;
        pendingPhotoRef.current = null;
        setAppState('answered');
        setStatusText('👁️🎙️ Look & Ask complete! Answer sent to watch display.');
        return;
      }

      // Otherwise, standard voice-only query:
      if (!question || (question.toLowerCase().includes('thank you') && totalBytes < 8000)) {
        setAppState('idle');
        setStatusText("No clear speech heard. Please tap 'Ask Voice AI' and speak clearly!");
        return;
      }

      setAppState('thinking');
      setStatusText(`Groq AI thinking: "${question}"...`);
      const { answer, llmMs } = await askGroqLLM(question, apiKey);

      await sendAnswerToWatch(answer);

      const totalMs = bleTransferMs + sttMs + llmMs;

      setChatHistory(prev => [
        {
          id: Date.now(),
          type: 'voice',
          question,
          answer,
          audioUrl,
          timing: { bleMs: bleTransferMs, sttMs, llmMs, totalMs },
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        },
        ...prev
      ]);

      setAppState('answered');
      setStatusText('Answered! Ready.');
    } catch (err) {
      console.error(err);
      isLookAndAskRef.current = false;
      pendingPhotoRef.current = null;
      setAppState('idle');
      setStatusText(`Error: ${err.message}`);
    }
  }

  async function sendAnswerToWatch(text) {
    if (!cmdCharRef.current) {
      console.warn('⚠️ [BLE] cmdCharRef is null, cannot send answer to watch');
      return;
    }

    try {
      // 1. Normalize Unicode punctuation to standard ASCII equivalents so watch TFT font renders cleanly
      let clean = text
        .replace(/[\u2018\u2019\u201A\u201B\u00B4`]/g, "'") // Single smart quotes & acute -> ASCII apostrophe
        .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"') // Double smart quotes -> ASCII quote
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-') // Hyphens, en-dash, em-dash, minus -> ASCII hyphen
        .replace(/\u2026/g, '...') // Ellipsis -> three dots
        .replace(/[\u2022\u2023\u25E6\u2043\u2219]/g, '- ') // Bullets -> ASCII hyphen list
        .replace(/[*#_`~]/g, '') // Strip markdown formatting
        .replace(/\n+/g, ' ') // Collapse newlines
        .trim();
      clean = clean.replace(/^(based on (the )?visible text[^:]*:|here is (the )?[^:]*:)/i, '').trim();
      const snippet = clean.substring(0, 320); // Up to 320 characters
      const encoder = new TextEncoder();
      const rawBytes = encoder.encode(snippet);
      const totalLen = rawBytes.length;

      console.log(`📡 [BLE] Streaming answer to watch in safe MTU chunks (${totalLen} bytes)...`);

      const writeSafe = async (buf) => {
        if (cmdCharRef.current.writeValueWithResponse) {
          await cmdCharRef.current.writeValueWithResponse(buf);
        } else if (cmdCharRef.current.writeValue) {
          await cmdCharRef.current.writeValue(buf);
        } else if (cmdCharRef.current.writeValueWithoutResponse) {
          await cmdCharRef.current.writeValueWithoutResponse(buf);
        }
      };

      // 2. Start Packet: [0x20, lenLo, lenHi] (3 bytes, fits MTU 23)
      const startPacket = new Uint8Array([0x20, totalLen & 0xFF, (totalLen >> 8) & 0xFF]);
      await writeSafe(startPacket);
      await new Promise(r => setTimeout(r, 25));

      // 3. Data Chunks: [0x21, byte0..byte17] (19 bytes total, strictly fits MTU 23)
      const CHUNK_SIZE = 18;
      let sent = 0;
      while (sent < totalLen) {
        const toSend = Math.min(CHUNK_SIZE, totalLen - sent);
        const chunk = new Uint8Array(toSend + 1);
        chunk[0] = 0x21;
        chunk.set(rawBytes.subarray(sent, sent + toSend), 1);

        await writeSafe(chunk);
        sent += toSend;
        await new Promise(r => setTimeout(r, 20)); // 20ms pacing
      }

      await new Promise(r => setTimeout(r, 30));

      // 4. End Packet: [0x22] (1 byte)
      const endPacket = new Uint8Array([0x22]);
      await writeSafe(endPacket);

      console.log('✅ [BLE] Answer successfully streamed to watch!');
      setStatusText('✅ Answer sent to watch display!');
    } catch (e) {
      console.error('❌ [BLE] Failed to stream answer to watch:', e);
      setStatusText(`⚠️ Could not send answer to watch: ${e.message}`);
    }
  }

  // -----------------------------------------------------------
  // Smartwatch Command Intent Resolver
  // -----------------------------------------------------------
  function resolveSmartwatchCommand(text) {
    if (!text) return null;
    const t = text.toLowerCase().trim();

    // Settings
    if (t.includes('setting') || t.includes('preference') || t.includes('option') || t.includes('config')) {
      return { type: 'OPEN', tag: 'SETTINGS', label: 'Opening Settings' };
    }
    // Calculator
    if (t.includes('calc') || t.includes('math') || t.includes('sum') || t.includes('calculate')) {
      return { type: 'OPEN', tag: 'CALC', label: 'Opening Calculator' };
    }
    // Music
    if (t.includes('music') || t.includes('song') || t.includes('track') || t.includes('player') || t.includes('spotify') || t.includes('tune')) {
      return { type: 'OPEN', tag: 'MUSIC', label: 'Opening Music' };
    }
    // QR Codes
    if (t.includes('qr') || t.includes('barcode') || t.includes('code') || t.includes('pass')) {
      return { type: 'OPEN', tag: 'MY_QRS', label: 'Opening QR Codes' };
    }
    // Flashlight / Torch
    if (t.includes('flashlight') || t.includes('torch') || t.includes('light') || t.includes('lamp')) {
      return { type: 'OPEN', tag: 'FLASHLIGHT', label: 'Opening Flashlight' };
    }
    // Clock / Alarm / Timer / Stopwatch
    if (t.includes('clock') || t.includes('alarm') || t.includes('timer') || t.includes('stopwatch') || t.includes('time')) {
      return { type: 'OPEN', tag: 'CLOCK', label: 'Opening Clock' };
    }
    // Calendar
    if (t.includes('calendar') || t.includes('date') || t.includes('event') || t.includes('schedule') || t.includes('month')) {
      return { type: 'OPEN', tag: 'CALENDAR', label: 'Opening Calendar' };
    }
    // Notifications
    if (t.includes('notification') || t.includes('alert') || t.includes('message') || t.includes('notice')) {
      return { type: 'OPEN', tag: 'NOTIFICATIONS', label: 'Opening Notifications' };
    }
    // AI Assistant (full Q&A / Vision)
    if (t.includes('assistant') || t.includes('ai') || t.includes('vision') || t.includes('ask ai') || t.includes('chat')) {
      return { type: 'OPEN', tag: 'AI_ASSISTANT', label: 'Opening AI Assistant' };
    }
    // Health / Steps
    if (t.includes('health') || t.includes('step') || t.includes('walk') || t.includes('fitness') || t.includes('activity')) {
      return { type: 'OPEN', tag: 'HEALTH', label: 'Opening Health' };
    }
    // Brightness
    if (t.includes('bright') || t.includes('dim') || t.includes('screen brightness')) {
      return { type: 'OPEN', tag: 'BRIGHTNESS', label: 'Opening Brightness' };
    }
    // Focus Mode
    if (t.includes('focus') || t.includes('pomodoro') || t.includes('study')) {
      return { type: 'OPEN', tag: 'FOCUS', label: 'Opening Focus Mode' };
    }
    // Menu / All Apps
    if (t.includes('menu') || t.includes('apps') || t.includes('launcher') || t.includes('drawer')) {
      return { type: 'OPEN', tag: 'MENU', label: 'Opening App Menu' };
    }
    // Watchface / Home
    if (t.includes('home') || t.includes('watchface') || t.includes('main') || t.includes('exit')) {
      return { type: 'OPEN', tag: 'WATCHFACE', label: 'Going to Home Screen' };
    }
    // About
    if (t.includes('about') || t.includes('system info') || t.includes('device') || t.includes('version')) {
      return { type: 'OPEN', tag: 'ABOUT', label: 'Opening About Watch' };
    }
    // Vault
    if (t.includes('vault') || t.includes('password') || t.includes('secret')) {
      return { type: 'OPEN', tag: 'VAULT', label: 'Opening Vault' };
    }
    // Macro
    if (t.includes('macro') || t.includes('shortcut')) {
      return { type: 'OPEN', tag: 'MACRO', label: 'Opening Macro' };
    }
    // Actions
    if (t === 'play' || t === 'pause' || t.includes('play pause') || t.includes('resume') || t.includes('toggle music')) {
      return { type: 'ACT', tag: 'PLAY_PAUSE', label: 'Toggling Music' };
    }
    if (t.includes('next') || t.includes('skip')) {
      return { type: 'ACT', tag: 'NEXT_TRACK', label: 'Next Track' };
    }
    if (t.includes('prev') || t.includes('previous') || t.includes('back track')) {
      return { type: 'ACT', tag: 'PREV_TRACK', label: 'Previous Track' };
    }
    if (t.includes('louder') || t.includes('volume up') || t.includes('turn up')) {
      return { type: 'ACT', tag: 'VOL_UP', label: 'Volume Up' };
    }
    if (t.includes('quieter') || t.includes('volume down') || t.includes('turn down')) {
      return { type: 'ACT', tag: 'VOL_DOWN', label: 'Volume Down' };
    }

    return null;
  }

  // -----------------------------------------------------------
  // Finish Assistant Voice Control Transfer
  // -----------------------------------------------------------
  async function finishControlAudioTransfer(bleTransferMs) {
    const totalBytes = streamChunksRef.current.reduce((acc, c) => acc + c.length, 0);
    if (totalBytes === 0) {
      setAppState('idle');
      setStatusText('No audio bytes received for command.');
      return;
    }

    const pcmBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of streamChunksRef.current) {
      pcmBytes.set(chunk, offset);
      offset += chunk.length;
    }

    const wavBlob = pcmToWavBlob(pcmBytes.buffer, sampleRateRef.current);
    const audioUrl = URL.createObjectURL(wavBlob);
    setActiveAudioUrl(audioUrl);

    setAppState('transcribing');
    setStatusText('🎙️ Transcribing voice command with Whisper...');

    try {
      const promptGuide = "Smartwatch voice command: open settings, start music, calculator, qrs, clock, flashlight, calendar, timer, alarm, stop, play, pause, next track, brightness, health, notifications, menu, watchface.";
      const { text: rawSpoken, sttMs } = await transcribeWithGroq(wavBlob, apiKey, promptGuide);
      const spokenText = rawSpoken.trim();

      if (!spokenText || (spokenText.toLowerCase().includes('thank you') && totalBytes < 8000)) {
        setAppState('idle');
        setStatusText("No clear command heard. Speak clearly (e.g. 'Open Settings', 'Start Music')");
        if (cmdCharRef.current) {
          const encoder = new TextEncoder();
          await cmdCharRef.current.writeValue(encoder.encode("CMD:ERROR:No speech heard"));
        }
        return;
      }

      setAppState('thinking');
      setStatusText(`⚡ Interpreting command: "${spokenText}"...`);

      // 1. First attempt fast local keyword matching (<1ms)
      let cmdResult = resolveSmartwatchCommand(spokenText);

      // 2. If unclassified, use fast Groq Llama 3.1 fallback (~200ms)
      let llmMs = 0;
      if (!cmdResult) {
        const t0 = performance.now();
        const tag = await classifyCommandWithLLM(spokenText, apiKey);
        llmMs = Math.round(performance.now() - t0);
        if (tag && tag.includes(':')) {
          const [type, t] = tag.split(':');
          cmdResult = { type, tag: t, label: (type === 'OPEN' ? `Opening ${t}` : `Action ${t}`) };
        }
      }

      const totalMs = bleTransferMs + sttMs + llmMs;

      if (cmdResult && cmdCharRef.current) {
        // Send command to watch display & OS router
        const blePayload = `CMD:${cmdResult.type}:${cmdResult.tag}:${cmdResult.label}`;
        const encoder = new TextEncoder();
        await cmdCharRef.current.writeValue(encoder.encode(blePayload));

        // Add to history feed
        setChatHistory(prev => [
          {
            id: Date.now(),
            type: 'control',
            isControl: true,
            question: spokenText,
            answer: `⚡ Command Executed: ${cmdResult.label} (${cmdResult.tag})`,
            audioUrl,
            timing: { bleMs: bleTransferMs, sttMs, llmMs, totalMs },
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          },
          ...prev
        ]);

        setStatusText(`✅ Executed on Watch: ${cmdResult.label}`);
        setAppState('answered');

        if (ttsEnabled) {
          speakTTS(cmdResult.label);
        }
      } else {
        // Unrecognized
        if (cmdCharRef.current) {
          const encoder = new TextEncoder();
          await cmdCharRef.current.writeValue(encoder.encode(`CMD:ERROR:Unknown: "${spokenText}"`));
        }

        setChatHistory(prev => [
          {
            id: Date.now(),
            type: 'control',
            isControl: true,
            question: spokenText,
            answer: `⚠️ Unrecognized command: "${spokenText}". Try 'Open Settings', 'Start Music', or 'Calculator'.`,
            audioUrl,
            timing: { bleMs: bleTransferMs, sttMs, llmMs, totalMs },
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          },
          ...prev
        ]);

        setStatusText(`⚠️ Command not recognized: "${spokenText}"`);
        setAppState('idle');
      }
    } catch (err) {
      console.error("Assistant control error:", err);
      setStatusText(`❌ Voice Control Error: ${err.message}`);
      if (cmdCharRef.current) {
        try {
          const encoder = new TextEncoder();
          await cmdCharRef.current.writeValue(encoder.encode("CMD:ERROR:Failed:" + err.message));
        } catch (e) {}
      }
      setAppState('idle');
    }
  }

  async function sendRemoteWatchCommand(type, tag, label) {
    if (!cmdCharRef.current || !isConnected) {
      alert("Watch is not connected via BLE!");
      return;
    }
    try {
      const blePayload = `CMD:${type}:${tag}:${label}`;
      const encoder = new TextEncoder();
      await cmdCharRef.current.writeValue(encoder.encode(blePayload));
      setStatusText(`⚡ Remote Command Sent: ${label}`);
    } catch (e) {
      console.error("Failed to send remote command:", e);
      setStatusText(`❌ Failed to send command: ${e.message}`);
    }
  }

  // -----------------------------------------------------------
  // Action Triggers to Watch
  // -----------------------------------------------------------
  async function triggerLookAndAsk() {
    if (!cmdCharRef.current) return;
    try {
      clearActivePhoto();
      isLookAndAskRef.current = true;
      const encoder = new TextEncoder();
      await cmdCharRef.current.writeValue(encoder.encode('LOOK_AND_ASK'));
      setStatusText('👁️🎙️ Look & Ask initiated! Watch is freezing frame & opening mic...');
      setAppState('idle');
    } catch (err) {
      console.error(err);
    }
  }

  async function triggerVoice() {
    if (!cmdCharRef.current) return;
    try {
      const encoder = new TextEncoder();
      await cmdCharRef.current.writeValue(encoder.encode('START_AUDIO'));
      setStatusText('🎙️ Watch microphone is listening... Speak your question!');
      setAppState('idle');
    } catch (err) {
      console.error(err);
    }
  }

  async function triggerSnapPhoto() {
    if (!cmdCharRef.current) return;
    try {
      clearActivePhoto();
      const encoder = new TextEncoder();
      await cmdCharRef.current.writeValue(encoder.encode('SNAP_PHOTO'));
      setStatusText('📸 Watch is snapping photo...');
      setAppState('idle');
    } catch (err) {
      console.error(err);
    }
  }

  function downloadCurrentPhoto() {
    if (!activePhotoUrl) return;
    const a = document.createElement('a');
    a.href = activePhotoUrl;
    a.download = `xiao_photo_${Date.now()}.jpg`;
    a.click();
  }

  function playAudio(url) {
    if (isPlayingAudio) {
      audioPlayerRef.current.pause();
      setIsPlayingAudio(false);
    } else {
      audioPlayerRef.current.src = url;
      audioPlayerRef.current.play();
      setIsPlayingAudio(true);
      audioPlayerRef.current.onended = () => setIsPlayingAudio(false);
    }
  }

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="header">
        <div className="brand">
          <div className="logo-icon">
            <Sparkles size={20} />
          </div>
          <div>
            <h1>XIAO Multimodal AI Watch</h1>
            <p className="subtitle">Voice &bull; Vision &bull; Real-time AI Assistant</p>
          </div>
        </div>

        <div className="header-actions">
          {isConnected ? (
            <button className="btn-conn connected" onClick={disconnectBluetooth}>
              <BluetoothConnected size={16} />
              <span>Connected</span>
            </button>
          ) : (
            <button className="btn-conn" onClick={connectBluetooth} disabled={isConnecting}>
              <Bluetooth size={16} />
              <span>{isConnecting ? 'Connecting...' : 'Connect Watch'}</span>
            </button>
          )}

          <button className={`btn-icon ${!apiKey ? 'btn-warn-glow' : ''}`} onClick={() => setShowSettings(!showSettings)} title="API Settings" style={{ position: 'relative' }}>
            <Settings size={18} />
            {!apiKey && (
              <span style={{
                position: 'absolute', top: '-4px', right: '-4px',
                width: '10px', height: '10px', borderRadius: '50%',
                background: '#ef4444', border: '2px solid #0f172a'
              }} />
            )}
          </button>
        </div>
      </header>

      {/* Settings Panel */}
      {showSettings && (
        <div className="settings-panel">
          <div className="settings-header">
            <h3>Groq Cloud AI Settings</h3>
            <span className="badge-shield"><ShieldCheck size={14} /> Direct Browser to Groq</span>
          </div>
          <div className="field-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ margin: 0 }}>Groq API Key</label>
              <span style={{ fontSize: '0.75rem', color: apiKey ? '#10b981' : '#f59e0b' }}>
                {apiKey ? '● Key Saved' : '● No Key Set'}
              </span>
            </div>
            <input 
              type="password" 
              value={apiKey} 
              onChange={e => setApiKey(e.target.value.trim())} 
              placeholder="gsk_..."
              style={{ marginTop: '0.4rem' }}
            />
            <p className="field-hint">Paste your Groq API key (starts with <code>gsk_...</code>). Stored locally in your browser.</p>
          </div>

          <div className="field-group">
            <label>Watch Viewfinder & Camera Rotation</label>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
              {[
                { deg: 270, label: '270° (Breadboard Default)' },
                { deg: 90, label: '90°' },
                { deg: 0, label: '0° (Unrotated)' },
                { deg: 180, label: '180°' }
              ].map(({ deg, label }) => (
                <button
                  key={deg}
                  type="button"
                  className={`btn-secondary ${watchRotation === deg ? 'btn-active' : ''}`}
                  style={{
                    padding: '0.4rem 0.8rem',
                    fontSize: '0.8rem',
                    background: watchRotation === deg ? '#06b6d4' : '#1e293b',
                    color: watchRotation === deg ? '#000' : '#fff',
                    borderColor: watchRotation === deg ? '#22d3ee' : '#334155'
                  }}
                  onClick={() => changeWatchRotation(deg)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="field-hint">Real-time switch: changes the live viewfinder on the watch display and orients incoming photos.</p>
          </div>

          <div className="field-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={autoProceedVision} 
                onChange={e => setAutoProceedVision(e.target.checked)}
                style={{ width: '16px', height: '16px', accentColor: '#06b6d4' }}
              />
              <span>Auto-Send to Vision AI when confirmed on watch (D1 tap)</span>
            </label>
            <p className="field-hint">When enabled, confirming on your wrist immediately calls Groq Vision and returns the answer to your watch display without needing your mouse.</p>
          </div>

          <div className="field-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={ttsEnabled} 
                onChange={e => setTtsEnabled(e.target.checked)}
                style={{ width: '16px', height: '16px', accentColor: '#a855f7' }}
              />
              <span>Speak AI answers aloud (Text-to-Speech)</span>
            </label>
            <p className="field-hint">When enabled, answers from Groq Vision and Voice are read out loud automatically via your computer/phone speakers.</p>
          </div>
        </div>
      )}

      {/* Status Bar */}
      <div className={`status-banner state-${appState}`}>
        <div className="status-indicator"></div>
        <span className="status-label">{statusText}</span>
      </div>

      {/* Progress Bar for BLE Transfer */}
      {appState === 'ble_transfer' && (
        <div className="transfer-box">
          <div className="transfer-bar" style={{ width: `${bleProgress}%` }}></div>
          <span className="transfer-pct">Transferring over BLE: {bleProgress}%</span>
        </div>
      )}

      {/* Trigger Buttons */}
      <div className="controls-grid">
        <button 
          className="action-card look-and-ask-card" 
          onClick={triggerLookAndAsk} 
          disabled={!isConnected || appState === 'ble_transfer' || appState === 'thinking'}
        >
          <div className="card-icon look-and-ask-icon">
            <Sparkles size={24} />
          </div>
          <div className="card-text">
            <h3>👁️🎙️ Look &amp; Ask AI</h3>
            <p>Aim watch camera &amp; speak your question</p>
          </div>
        </button>

        <button 
          className="action-card vision-card" 
          onClick={triggerSnapPhoto} 
          disabled={!isConnected || appState === 'ble_transfer' || appState === 'thinking'}
        >
          <div className="card-icon vision-icon">
            <Camera size={24} />
          </div>
          <div className="card-text">
            <h3>📸 Capture Camera Photo</h3>
            <p>Snap photo from watch &amp; review before sending</p>
          </div>
        </button>

        <button 
          className="action-card voice-card" 
          onClick={triggerVoice} 
          disabled={!isConnected || appState === 'ble_transfer' || appState === 'thinking'}
        >
          <div className="card-icon voice-icon">
            <Mic size={24} />
          </div>
          <div className="card-text">
            <h3>🎙️ Ask Voice AI</h3>
            <p>Speak to the watch mic &amp; get instant answer</p>
          </div>
        </button>
      </div>

      {/* Smartwatch Voice & App Remote Controller */}
      <div className="remote-control-panel">
        <div className="remote-panel-header">
          <span className="remote-title">
            <Zap size={16} /> Assistant Smartwatch Controller
          </span>
          <span className="remote-sub">Voice Control or 1-Click Launch on Watch</span>
        </div>
        <div className="app-pills-grid">
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'SETTINGS', 'Opening Settings')} disabled={!isConnected}>
            ⚙️ Settings
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'CALC', 'Opening Calculator')} disabled={!isConnected}>
            🧮 Calculator
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'MUSIC', 'Opening Music')} disabled={!isConnected}>
            🎵 Music
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'MY_QRS', 'Opening QR Codes')} disabled={!isConnected}>
            📱 My QRs
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'AI_ASSISTANT', 'Opening AI Assistant')} disabled={!isConnected}>
            🤖 AI Assistant
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'CLOCK', 'Opening Clock')} disabled={!isConnected}>
            ⏰ Clock
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'FLASHLIGHT', 'Opening Flashlight')} disabled={!isConnected}>
            🔦 Flashlight
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'CALENDAR', 'Opening Calendar')} disabled={!isConnected}>
            📅 Calendar
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'NOTIFICATIONS', 'Opening Notifications')} disabled={!isConnected}>
            🔔 Notifications
          </button>
          <button className="app-pill" onClick={() => sendRemoteWatchCommand('OPEN', 'WATCHFACE', 'Going to Watchface')} disabled={!isConnected}>
            🏠 Watchface
          </button>
        </div>
      </div>

      {/* Photo Viewport with Review & Decision Bar */}
      {activePhotoUrl && (
        <div className="photo-viewport-card">
          <div className="photo-card-header">
            <span style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
              <Camera size={16} /> Watch Photo Preview
            </span>
            <div className="photo-badges">
              {photoMeta && <span className="meta-tag">{photoMeta.sizeKb} KB</span>}
              {photoMeta && <span className="meta-tag">{photoMeta.width}x{photoMeta.height}</span>}
              {photoMeta && <span className="meta-tag">BLE: {photoMeta.bleMs}ms</span>}
              <button className="btn-text-clear" onClick={clearActivePhoto} title="Discard Photo">
                <X size={14} /> Clear
              </button>
            </div>
          </div>

          {/* Photo Display */}
          <div className="photo-box">
            <img src={activePhotoUrl} alt="Captured from watch" />
          </div>

          {/* Review & Decision Bar (DO NOT send unless user clicks Proceed!) */}
          <div className="review-action-card">
            <div className="review-title">
              <span>Choose an action for this photo:</span>
            </div>

            <div className="review-prompt-row">
              <input 
                type="text"
                value={customVisionPrompt}
                onChange={e => setCustomVisionPrompt(e.target.value)}
                placeholder="Ask something about this image..."
                disabled={appState === 'thinking'}
                onKeyDown={e => { if (e.key === 'Enter') proceedWithVisionAI(); }}
              />
              <button 
                className="btn-proceed" 
                onClick={proceedWithVisionAI}
                disabled={appState === 'thinking'}
              >
                <Sparkles size={16} />
                <span>{appState === 'thinking' ? 'Processing...' : 'Proceed with AI'}</span>
              </button>
            </div>

            <div className="review-btn-row">
              <button className="btn-secondary" onClick={triggerSnapPhoto} disabled={appState === 'thinking'}>
                <RefreshCw size={15} />
                <span>Retake Photo</span>
              </button>
              <button className="btn-secondary" onClick={rotateActivePhoto} disabled={appState === 'thinking'} title="Rotate photo 90 degrees clockwise">
                <RotateCw size={15} />
                <span>Rotate 90°</span>
              </button>
              <button className="btn-secondary btn-danger-outline" onClick={clearActivePhoto} disabled={appState === 'thinking'}>
                <X size={15} />
                <span>Discard</span>
              </button>
              <button className="btn-secondary" onClick={downloadCurrentPhoto}>
                <Download size={15} />
                <span>Save JPG</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Conversation Feed */}
      <div className="feed-section">
        <div className="feed-header">
          <h2>Activity &amp; AI Responses ({chatHistory.length})</h2>
        </div>

        {chatHistory.length === 0 ? (
          <div className="empty-state">
            <p>No queries yet. Tap <strong>Look &amp; Ask</strong> or tap <strong>D1</strong> on your watch to ask questions about anything!</p>
          </div>
        ) : (
          <div className="chat-feed">
            {chatHistory.map(item => (
              <div key={item.id} className={`chat-card type-${item.type}`}>
                <div className="card-top">
                  <div className="type-badge">
                    {item.type === 'voice' && <span>🎙️ Voice Question</span>}
                    {item.type === 'vision' && <span>📸 Camera Vision AI</span>}
                    {item.type === 'look_and_ask' && <span>👁️🎙️ Look &amp; Ask Multimodal AI</span>}
                    {item.type === 'control' && <span>⚡ Smartwatch Voice Command</span>}
                  </div>
                  <span className="timestamp">{item.timestamp}</span>
                </div>

                {item.imageUrl && (
                  <div className="card-image-preview" onClick={() => window.open(item.imageUrl, '_blank')} title="Click to open full-resolution photo">
                    <img src={item.imageUrl} alt="Query visual" />
                  </div>
                )}

                <div className="question-bubble">
                  <strong>You:</strong> {item.question}
                  {item.audioUrl && (
                    <button className="btn-audio-pill" onClick={() => playAudio(item.audioUrl)}>
                      {isPlayingAudio ? <Pause size={12} /> : <Play size={12} />}
                      <span>Listen</span>
                    </button>
                  )}
                </div>

                <div className="answer-bubble">
                  <div className="answer-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <Sparkles size={14} className="sparkle-icon" />
                      <strong>{item.isControl ? 'Smartwatch Action:' : 'Groq AI:'}</strong>
                    </div>
                    <button 
                      className="btn-speak-inline" 
                      onClick={() => speakText(item.answer)} 
                      title="Speak answer aloud"
                    >
                      <Volume2 size={13} />
                      <span>Speak</span>
                    </button>
                  </div>
                  <p>{item.answer}</p>
                </div>

                {item.timing && (
                  <div className="timing-pills">
                    {item.timing.bleMs !== undefined && (
                      <span className="timing-pill">BLE: {item.timing.bleMs}ms</span>
                    )}
                    {item.timing.blePhotoMs !== undefined && (
                      <span className="timing-pill">Photo BLE: {item.timing.blePhotoMs}ms</span>
                    )}
                    {item.timing.bleAudioMs !== undefined && (
                      <span className="timing-pill">Audio BLE: {item.timing.bleAudioMs}ms</span>
                    )}
                    {item.timing.sttMs !== undefined && (
                      <span className="timing-pill">Whisper STT: {item.timing.sttMs}ms</span>
                    )}
                    {item.timing.visionMs !== undefined && (
                      <span className="timing-pill">Vision AI: {item.timing.visionMs}ms</span>
                    )}
                    {item.timing.llmMs !== undefined && (
                      <span className="timing-pill">LLM: {item.timing.llmMs}ms</span>
                    )}
                    <span className="timing-pill total">Total: {item.timing.totalMs}ms</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
