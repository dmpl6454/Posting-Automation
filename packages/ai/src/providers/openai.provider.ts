import { ChatOpenAI } from "@langchain/openai";

export function getOpenAIModel(temperature = 0.7) {
  return new ChatOpenAI({
    modelName: "gpt-4-turbo",
    temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}
