// import { createLLMClient } from "@/runtime/shared/llm-client";
// import { generateText, tool } from "ai";
// import { NextResponse } from "next/server";
// import { z } from "zod";
// import OpenAI from "openai";
// import { Readable } from "stream";
// import axios from "axios";

import { wacloud } from "@/lib/wacloud";

// async function transcribeFromUrl(openai: OpenAI, url: string) {
//   const res = await axios.get(url, { responseType: "arraybuffer" });

//   const buffer = Buffer.from(res.data);

//   const stream = Readable.from(buffer);

//   const transcription = await openai.audio.transcriptions.create({
//     file: stream,
//     model: "gpt-4o-transcribe",
//   });

//   return transcription.text;
// }

// const GET = async () => {
//   const openaiclient = new OpenAI();

//   const transcription = await transcribeFromUrl(
//     openaiclient,
//     "https://r2.sevai.app/audio/1547136293296370.ogg"
//   );

//   return NextResponse.json({
//     message: transcription
//   })

//   const model = createLLMClient("agent1");

//   const result = await generateText({
//     model: model,
//     messages: [
//       {
//         role: "user",
//         content: [
//           {
//             type: "text",
//             text: "Are you able to access and read the file that I gave you, tell me about it",
//           },
//           {
//             type: "file",
//             data: new URL("https://r2.sevai.app/audio/1547136293296370.ogg"),
//             mediaType: "audio/ogg",
//           },
//         ],
//       },
//     ],
//     tools: {
//       log: tool({
//         description: "Log text in the system",
//         inputSchema: z.object({
//           text: z.string(),
//         }),
//         execute({ text }) {
//           console.log(text);
//         },
//       }),
//     },
//   });

//   console.log(result.text);

//   return NextResponse.json({
//     message: "Success",
//   });
// };

// export { GET };

const GET = () => {
  wacloud.sendMessage({
    to: "919324612161",
    message: "WE OUSSIDE",
    enableLinkPreview: false,
  });
};


export {GET};