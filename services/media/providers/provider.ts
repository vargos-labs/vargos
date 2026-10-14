export interface MediaProvider {
  transcribeAudio(filePath: string, model: string, apiKey: string, baseUrl?: string): Promise<string>;
  describeImage(filePath: string, model: string, apiKey: string, baseUrl?: string): Promise<string>;
  synthesizeSpeech(params: {
    text: string;
    model: string;
    apiKey: string;
    voice?: string;
    responseFormat?: string;
    baseUrl?: string;
  }): Promise<Buffer>;
}
