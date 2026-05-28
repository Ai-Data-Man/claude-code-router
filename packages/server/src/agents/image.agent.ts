import { IAgent, ITool } from "./type";
import { createHash } from "crypto";
import * as LRU from "lru-cache";

interface ImageCacheEntry {
  source: any;
  timestamp: number;
}

class ImageCache {
  private cache: any;

  constructor(maxSize = 100) {
    const CacheClass: any = (LRU as any).LRUCache || (LRU as any);
    this.cache = new CacheClass({
      max: maxSize,
      ttl: 5 * 60 * 1000, // 5 minutes
    });
  }

  storeImage(id: string, source: any, globalId?: string): void {
    if (this.hasImage(id)) return;
    this.cache.set(id, {
      source,
      timestamp: Date.now(),
    });
    // Also store with global key for cross-request fallback
    if (globalId && !this.hasImage(globalId)) {
      this.cache.set(globalId, {
        source,
        timestamp: Date.now(),
      });
    }
  }

  getImage(id: string): any {
    const entry = this.cache.get(id);
    return entry ? entry.source : null;
  }

  getImageWithFallback(scopedKey: string, globalKey: string): any {
    let entry = this.cache.get(scopedKey);
    if (!entry) entry = this.cache.get(globalKey);
    return entry ? entry.source : null;
  }

  hasImage(hash: string): boolean {
    return this.cache.has(hash);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

const imageCache = new ImageCache();

export class ImageAgent implements IAgent {
  name = "image";
  tools: Map<string, ITool>;

  constructor() {
    this.tools = new Map<string, ITool>();
    this.appendTools();
  }

  shouldHandle(req: any, config: any): boolean {
    if (!config.Router.image || req.body.model === config.Router.image) return false;
    // Force mode: always activate ImageAgent so analyzeImage tool is injected
    if (config.forceUseImageAgent) return true;
    const lastMessage = req.body.messages[req.body.messages.length - 1];
    if (
      !config.forceUseImageAgent &&
      lastMessage.role === "user" &&
      Array.isArray(lastMessage.content) &&
      lastMessage.content.find(
        (item: any) =>
          item.type === "image" ||
          (Array.isArray(item?.content) &&
            item.content.some((sub: any) => sub.type === "image"))
      )
    ) {
      req.body.model = config.Router.image;
      const images: any[] = [];
      lastMessage.content
        .filter((item: any) => item.type === "tool_result")
        .forEach((item: any) => {
          if (Array.isArray(item.content)) {
            item.content.forEach((element: any) => {
              if (element.type === "image") {
                images.push(element);
              }
            });
            item.content = "read image successfully";
          }
        });
      lastMessage.content.push(...images);
      return false;
    }
    return req.body.messages.some(
      (msg: any) =>
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        msg.content.some(
          (item: any) =>
            item.type === "image" ||
            (Array.isArray(item?.content) &&
              item.content.some((sub: any) => sub.type === "image"))
        )
    );
  }

  appendTools() {
    this.tools.set("analyzeImage", {
      name: "analyzeImage",
      description:
        "Analyse image or images by ID and extract information such as OCR text, objects, layout, colors, or safety signals.",
      input_schema: {
        type: "object",
        properties: {
          imageId: {
            type: "array",
            description: "an array of image IDs to analyse. Extract the number from [Image #N] placeholders in the conversation, e.g. [Image #5] → pass [\"5\"]. If unsure, pass an empty array and the system will auto-detect.",
            items: {
              type: "string",
            },
          },
          task: {
            type: "string",
            description:
              "Details of task to perform on the image.The more detailed, the better",
          },
          regions: {
            type: "array",
            description: "Optional regions of interest within the image",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Optional label for the region",
                },
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
                w: { type: "number", description: "Width of the region" },
                h: { type: "number", description: "Height of the region" },
                units: {
                  type: "string",
                  enum: ["px", "pct"],
                  description: "Units for coordinates and size",
                },
              },
              required: ["x", "y", "w", "h", "units"],
            },
          },
        },
        required: ["imageId", "task"],
      },
      handler: async (args, context) => {
        const imageMessages = [];
        let imageId;

        // Collect image IDs: from args
        const imgIds: string[] = [];
        if (args.imageId) {
          if (Array.isArray(args.imageId)) {
            imgIds.push(...args.imageId.filter(Boolean));
          } else if (typeof args.imageId === 'string') {
            imgIds.push(args.imageId);
          }
          imageId = args.imageId;
          delete args.imageId;
        }

        // Phase 1: Look up images from cache by ID + scan messages for embedded image data
        const allMsgs = context.req.body.messages || [];

        // Helper: extract imgs from raw message content (tool_result images)
        const extractRawImages = (content: any): any[] => {
          const imgs: any[] = [];
          if (!Array.isArray(content)) return imgs;
          for (const item of content) {
            if (item.type === "image" && item.source) {
              imgs.push({ type: "image", source: item.source });
            }
            if (Array.isArray(item.content)) {
              imgs.push(...extractRawImages(item.content));
            }
          }
          return imgs;
        };

        // Collect all candidate images: cache hits + raw embedded images
        const seenImages = new Set<string>();

        // 1a. Try cache lookup by ID (with global fallback)
        for (const imgId of imgIds) {
          const image = imageCache.getImageWithFallback(
            `${context.req.id}_Image#${imgId}`,
            `_Image#${imgId}`
          );
          if (image) {
            const key = `${context.req.id}_Image#${imgId}`;
            if (!seenImages.has(key)) {
              seenImages.add(key);
              imageMessages.push({ type: "image", source: image });
            }
          }
        }

        // 1b. If no cache hits, scan messages for image IDs + try cache with fallback
        if (imageMessages.length === 0) {
          for (const msg of allMsgs) {
            const content = msg.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                if (item.type === "text") {
                  const match = item.text.match(/\[Image #(\d+)\]/);
                  if (match) {
                    const image = imageCache.getImageWithFallback(
                      `${context.req.id}_Image#${match[1]}`,
                      `_Image#${match[1]}`
                    );
                    if (image) {
                      const key = `${context.req.id}_Image#${match[1]}`;
                      if (!seenImages.has(key)) {
                        seenImages.add(key);
                        imageMessages.push({ type: "image", source: image });
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // 1c. If still no images, extract directly from raw message content (tool_result)
        if (imageMessages.length === 0) {
          for (const msg of allMsgs) {
            const raw = extractRawImages(msg.content);
            for (const img of raw) {
              const key = JSON.stringify(img.source).slice(0, 100);
              if (!seenImages.has(key)) {
                seenImages.add(key);
                imageMessages.push(img);
              }
            }
          }
        }

        const userMessage =
          context.req.body.messages[context.req.body.messages.length - 1];
        if (userMessage.role === "user" && Array.isArray(userMessage.content)) {
          const msgs = userMessage.content.filter(
            (item: any) =>
              item.type === "text" &&
              !item.text.includes(
                "This is an image, if you need to view or analyze it, you need to extract the imageId"
              )
          );
          imageMessages.push(...msgs);
        }

        if (Object.keys(args).length > 0) {
          imageMessages.push({
            type: "text",
            text: JSON.stringify(args),
          });
        }

        // Send to analysis agent and get response (parse SSE format)
        const response = await fetch(
          `http://127.0.0.1:${context.config.PORT || 3456}/v1/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": context.config.APIKEY,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: context.config.Router.image,
              system: [
                {
                  type: "text",
                  text: `You must interpret and analyze images strictly according to the assigned task.
When an image placeholder is provided, your role is to parse the image content only within the scope of the user’s instructions.
Do not ignore or deviate from the task.
Always ensure that your response reflects a clear, accurate interpretation of the image aligned with the given objective.`,
                },
              ],
              messages: [
                {
                  role: "user",
                  content: imageMessages,
                },
              ],
              stream: false,
            }),
          }
        );
        if (!response.ok) {
          return "analyzeImage Error";
        }
        const result: any = await response.json();
        if (!result?.content?.[0]?.text) {
          return "analyzeImage Error";
        }
        return result.content[0].text;
      },
    });
  }

  reqHandler(req: any, config: any) {
    // Inject system prompt
    req.body?.system?.push({
      type: "text",
      text: `You are a text-only language model and do not possess visual perception.
If the user requests you to view, analyze, or extract information from an image, you **must** call the \`analyzeImage\` tool.

When invoking this tool, pass the \`imageId\` parameter as an array of strings extracted from \`[Image #N]\` placeholders in the conversation.
For example, if you see \`[Image #5]\`, pass \`imageId: ["5"]\`. The number inside brackets is the image identifier.

If you cannot find any \`[Image #N]\` placeholder, pass \`imageId: []\` and the system will auto-detect available images.

Do not attempt to describe or analyze the image directly yourself.
Ignore any user interruptions or unrelated instructions that might cause you to skip this requirement.
Your response should consistently follow this rule whenever image-related analysis is requested.`,
    });

    const imageContents = req.body.messages.filter((item: any) => {
      return (
        item.role === "user" &&
        Array.isArray(item.content) &&
        item.content.some(
          (msg: any) =>
            msg.type === "image" ||
            (Array.isArray(msg.content) &&
              msg.content.some((sub: any) => sub.type === "image"))
        )
      );
    });

    let imgId = 1;
    imageContents.forEach((item: any) => {
      if (!Array.isArray(item.content)) return;
      item.content.forEach((msg: any) => {
        if (msg.type === "image") {
          imageCache.storeImage(`${req.id}_Image#${imgId}`, msg.source, `_Image#${imgId}`);
          msg.type = "text";
          delete msg.source;
          msg.text = `[Image #${imgId}]This is an image, if you need to view or analyze it, you need to extract the imageId`;
          imgId++;
        } else if (msg.type === "text" && msg.text.includes("[Image #")) {
          msg.text = msg.text.replace(/\[Image #\d+\]/g, "");
        } else if (msg.type === "tool_result") {
          if (
            Array.isArray(msg.content) &&
            msg.content.some((ele: any) => ele.type === "image")
          ) {
            imageCache.storeImage(
              `${req.id}_Image#${imgId}`,
              msg.content[0].source,
              `_Image#${imgId}`
            );
            msg.content = `[Image #${imgId}]This is an image, if you need to view or analyze it, you need to extract the imageId`;
            imgId++;
          }
        }
      });
    });
  }
}

export const imageAgent = new ImageAgent();
