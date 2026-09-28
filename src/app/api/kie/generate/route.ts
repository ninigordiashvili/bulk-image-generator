import { generateKieImage } from "@/server/imageGeneration";
export const maxDuration = 300;
export async function POST(request: Request) { return generateKieImage(request); }
