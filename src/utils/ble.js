// -------------------------------------------------------------
// BLE Service & Characteristic UUIDs (Matches ESP32 firmware)
// -------------------------------------------------------------
export const SERVICE_UUID     = '19b10000-e8f2-537e-4f6c-d104768a1214';
export const CHAR_STREAM_UUID  = '19b10001-e8f2-537e-4f6c-d104768a1214'; // Audio & Image packets
export const CHAR_AUDIO_UUID   = CHAR_STREAM_UUID; // Alias for backward compatibility
export const CHAR_CMD_UUID     = '19b10002-e8f2-537e-4f6c-d104768a1214'; // Commands & Text

/**
 * Packs 16-bit Mono PCM bytes into a standard 44-byte WAV Blob.
 */
export function pcmToWavBlob(pcmBytes, sampleRate = 8000) {
  const wavHeader = new ArrayBuffer(44);
  const view = new DataView(wavHeader);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);             // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);              // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true);              // NumChannels (1 = Mono)
  view.setUint32(24, sampleRate, true);     // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true);              // BlockAlign
  view.setUint16(34, 16, true);             // BitsPerSample (16-bit)

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, pcmBytes.byteLength, true);

  return new Blob([wavHeader, pcmBytes], { type: 'audio/wav' });
}

/**
 * Converts a Blob to a raw base64 string (without the data URL prefix).
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      } else {
        reject(new Error('Failed to read blob as data URL'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
