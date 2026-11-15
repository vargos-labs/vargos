export interface MediaProvider {
  transcribeAudio(filePath: string, model: string, apiKey: string, baseUrl?: string): Promise<string>;
  describeImage(filePath: string, model: string, apiKey: string, baseUrl?: string): Promise<string>;
}
