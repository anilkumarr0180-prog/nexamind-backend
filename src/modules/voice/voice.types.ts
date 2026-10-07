export interface TranscriptionResult {
  text: string;
  duration?: number | undefined;
  language?: string | undefined;
}

export interface TranscribeAudioOptions {
  model?: string | undefined;
  language?: string | undefined;
  prompt?: string | undefined;
  temperature?: number | undefined;
}
