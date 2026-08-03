/**
 * Catalog of every image model kie.ai serves, generated from the OpenAPI specs
 * published at docs.kie.ai (fetched 2026-07-31).
 *
 * Each model declares its own input schema, so the settings panel is rendered
 * from `options` rather than hard-coded — that is what makes "pick any model"
 * work without a code change per model. Anything not listed here can still be
 * run through the custom-model escape hatch, which posts a raw `input` object.
 *
 * To refresh: every page under https://docs.kie.ai/market/<group>/<model> also
 * serves its OpenAPI YAML at `<url>.md`.
 */

export interface KieFieldSpec {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  /** Present for closed sets — rendered as pills instead of a free-text field. */
  enum?: readonly string[];
  default?: string | number | boolean;
  maxLength?: number;
  /** kie rejects the call outright when a required field is missing. */
  required?: boolean;
  description?: string;
}

export interface KieModelSpec {
  /** The exact string createTask expects in `model`. */
  id: string;
  label: string;
  group: string;
  docUrl: string;
  /** Longest prompt the model accepts, in characters. */
  promptMax: number;
  /**
   * Input field carrying reference-image URLs, absent on text-to-image-only
   * models. kie takes URLs, never bytes, so uploads go through the file API first.
   */
  imageField?: string;
  imageMax?: number;
  /** True when the field is a single URL string rather than an array. */
  imageSingle?: boolean;
  /** Everything except prompt and images — drives the dynamic settings UI. */
  options: readonly KieFieldSpec[];
}

export const KIE_MODELS: readonly KieModelSpec[] = [
  {
    id: "nano-banana-2",
    label: "Nano Banana 2",
    group: "Google",
    docUrl: "https://docs.kie.ai/market/google/nanobanana2",
    promptMax: 20000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "1:4",
          "1:8",
          "2:3",
          "3:2",
          "3:4",
          "4:1",
          "4:3",
          "4:5",
          "5:4",
          "8:1",
          "9:16",
          "16:9",
          "21:9",
          "auto"
        ],
        default: "auto",
        description: "Aspect ratio of the generated image"
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K",
          "4K"
        ],
        default: "1K",
        description: "Resolution of the generated image"
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpg"
        ],
        default: "jpg",
        description: "Format of the output image"
      }
    ],
    imageField: "image_input",
    imageMax: 14,
    imageSingle: false
  },
  {
    id: "nano-banana-pro",
    label: "Nano Banana Pro",
    group: "Google",
    docUrl: "https://docs.kie.ai/market/google/pro-image-to-image",
    promptMax: 10000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "2:3",
          "3:2",
          "3:4",
          "4:3",
          "4:5",
          "5:4",
          "9:16",
          "16:9",
          "21:9",
          "auto"
        ],
        default: "1:1",
        description: "Aspect ratio of the generated image"
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K",
          "4K"
        ],
        default: "1K",
        description: "Resolution of the generated image"
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpg"
        ],
        default: "png",
        description: "Format of the output image"
      }
    ],
    imageField: "image_input",
    imageMax: 8,
    imageSingle: false
  },
  {
    id: "nano-banana-2-lite",
    label: "Nano Banana 2 Lite",
    group: "Google",
    docUrl: "https://docs.kie.ai/market/google/nano-banana-2-lite",
    promptMax: 20000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "1:4",
          "1:8",
          "2:3",
          "3:2",
          "3:4",
          "4:1",
          "4:3",
          "4:5",
          "5:4",
          "8:1",
          "9:16",
          "16:9",
          "21:9",
          "auto"
        ],
        default: "auto",
        required: true,
        description: "Generated image aspect ratio. Default value: `auto`. Use `auto` to let the system choose the aspect ratio automatically."
      }
    ],
    imageField: "image_urls",
    imageMax: 10,
    imageSingle: false
  },
  {
    id: "google/nano-banana",
    label: "Nano Banana",
    group: "Google",
    docUrl: "https://docs.kie.ai/market/google/nano-banana",
    promptMax: 5000,
    options: [
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpeg"
        ],
        default: "png",
        description: "Output format for the images"
      },
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "9:16",
          "16:9",
          "3:4",
          "4:3",
          "3:2",
          "2:3",
          "5:4",
          "4:5",
          "21:9",
          "auto"
        ],
        default: "1:1",
        description: "Radio description"
      },
      {
        name: "image_size",
        type: "string",
        enum: [
          "1:1",
          "9:16",
          "16:9",
          "3:4",
          "4:3",
          "3:2",
          "2:3",
          "5:4",
          "4:5",
          "21:9",
          "auto"
        ],
        default: "1:1",
        description: "The aspect ratio of the generated image (this parameter has been replaced by aspect_ratio; please use the latest aspect_"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ]
  },
  {
    id: "google/nano-banana-edit",
    label: "Nano Banana Edit",
    group: "Google",
    docUrl: "https://docs.kie.ai/market/google/nano-banana-edit",
    promptMax: 5000,
    options: [
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpeg"
        ],
        default: "png",
        description: "Output format for the images"
      },
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "9:16",
          "16:9",
          "3:4",
          "4:3",
          "3:2",
          "2:3",
          "5:4",
          "4:5",
          "21:9",
          "auto"
        ],
        default: "1:1",
        description: "Radio description"
      },
      {
        name: "image_size",
        type: "string",
        enum: [
          "1:1",
          "9:16",
          "16:9",
          "3:4",
          "4:3",
          "3:2",
          "2:3",
          "5:4",
          "4:5",
          "21:9",
          "auto"
        ],
        default: "1:1",
        description: "The aspect ratio of the generated image (this parameter has been replaced by aspect_ratio; please use the latest aspect_"
      }
    ],
    imageField: "image_urls",
    imageMax: 10,
    imageSingle: false
  },
  {
    id: "flux-2/flex-image-to-image",
    label: "Flux-2 - Image to Image",
    group: "Flux 2",
    docUrl: "https://docs.kie.ai/market/flux2/flex-image-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "3:2",
          "2:3",
          "auto"
        ],
        default: "1:1",
        required: true,
        description: "Aspect ratio for the generated image. Select 'auto' to match the first input image ratio (requires input image)."
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K"
        ],
        default: "1K",
        required: true,
        description: "Output image resolution."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "input_urls",
    imageMax: 8,
    imageSingle: false
  },
  {
    id: "flux-2/pro-image-to-image",
    label: "Flux-2 - Pro Image to Image",
    group: "Flux 2",
    docUrl: "https://docs.kie.ai/market/flux2/pro-image-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "3:2",
          "2:3",
          "auto"
        ],
        default: "1:1",
        required: true,
        description: "Aspect ratio for the generated image. Select 'auto' to match the first input image ratio (requires input image)."
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K"
        ],
        default: "1K",
        required: true,
        description: "Output image resolution."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "input_urls",
    imageMax: 8,
    imageSingle: false
  },
  {
    id: "flux-2/pro-text-to-image",
    label: "Flux-2 - Pro Text to Image",
    group: "Flux 2",
    docUrl: "https://docs.kie.ai/market/flux2/pro-text-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "3:2",
          "2:3"
        ],
        default: "1:1",
        required: true,
        description: "Aspect ratio for the generated image. Select 'auto' to match the first input image ratio (requires input image)."
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K"
        ],
        default: "1K",
        required: true,
        description: "Output image resolution."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ]
  },
  {
    id: "flux-2/flex-text-to-image",
    label: "Flux-2 - Text to Image",
    group: "Flux 2",
    docUrl: "https://docs.kie.ai/market/flux2/flex-text-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "3:2",
          "2:3"
        ],
        default: "1:1",
        required: true,
        description: "Aspect ratio of the generated image. When `auto` is selected, it will match the ratio of the first input image (requires"
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K"
        ],
        default: "1K",
        required: true,
        description: "Output image resolution."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ]
  },
  {
    id: "google/imagen4",
    label: "imagen4",
    group: "Google",
    docUrl: "https://docs.kie.ai/market/google/imagen4",
    promptMax: 5000,
    options: [
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 5000,
        description: "A description of what to discourage in the generated images (Max length: 5000 characters)"
      },
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "16:9",
          "9:16",
          "3:4",
          "4:3",
          "auto"
        ],
        default: "1:1",
        description: "The aspect ratio of the generated image"
      }
    ]
  },
  {
    id: "google/imagen4-fast",
    label: "imagen4-fast",
    group: "Google",
    docUrl: "https://docs.kie.ai/market/google/imagen4-fast",
    promptMax: 5000,
    options: [
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 5000,
        description: "A description of what to discourage in the generated images (Max length: 5000 characters)"
      },
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "16:9",
          "9:16",
          "3:4",
          "4:3",
          "auto"
        ],
        default: "16:9",
        description: "The aspect ratio of the generated image"
      }
    ]
  },
  {
    id: "google/imagen4-ultra",
    label: "imagen4-ultra",
    group: "Google",
    docUrl: "https://docs.kie.ai/market/google/imagen4-ultra",
    promptMax: 5000,
    options: [
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 5000,
        description: "A description of what to discourage in the generated images (Max length: 5000 characters)"
      },
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "16:9",
          "9:16",
          "3:4",
          "4:3",
          "auto"
        ],
        default: "1:1",
        description: "The aspect ratio of the generated image"
      }
    ]
  },
  {
    id: "ideogram/character",
    label: "Character",
    group: "Ideogram",
    docUrl: "https://docs.kie.ai/market/ideogram/character",
    promptMax: 5000,
    options: [
      {
        name: "rendering_speed",
        type: "string",
        enum: [
          "TURBO",
          "BALANCED",
          "QUALITY"
        ],
        default: "BALANCED",
        description: "The rendering speed to use. Default value: \"BALANCED\""
      },
      {
        name: "style",
        type: "string",
        enum: [
          "AUTO",
          "REALISTIC",
          "FICTION"
        ],
        default: "AUTO",
        description: "The style type to generate with. Cannot be used with style_codes. Default value: \"AUTO\""
      },
      {
        name: "expand_prompt",
        type: "boolean",
        description: "Determine if MagicPrompt should be used in generating the request or not. Default value: true (Boolean value (true/false"
      },
      {
        name: "num_images",
        type: "string",
        enum: [
          "1",
          "2",
          "3",
          "4"
        ],
        default: "1",
        description: "Select description"
      },
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9"
        ],
        default: "square_hd",
        description: "The resolution of the generated image Default value: square_hd"
      },
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 5000,
        description: "Description of what to exclude from an image. Descriptions in the prompt take precedence to descriptions in the negative"
      }
    ],
    imageField: "reference_image_urls",
    imageMax: 10,
    imageSingle: false
  },
  {
    id: "ideogram/character-edit",
    label: "Character Edit",
    group: "Ideogram",
    docUrl: "https://docs.kie.ai/market/ideogram/character-edit",
    promptMax: 5000,
    options: [
      {
        name: "image_url",
        type: "string",
        required: true,
        description: "The image URL to generate an image from. Needs to match the dimensions of the mask. (File URL after upload, not file con"
      },
      {
        name: "rendering_speed",
        type: "string",
        enum: [
          "TURBO",
          "BALANCED",
          "QUALITY"
        ],
        default: "BALANCED",
        description: "The rendering speed to use. Default value: \"BALANCED\""
      },
      {
        name: "style",
        type: "string",
        enum: [
          "AUTO",
          "REALISTIC",
          "FICTION"
        ],
        default: "AUTO",
        description: "The style type to generate with. Cannot be used with style_codes. Default value: \"AUTO\""
      },
      {
        name: "expand_prompt",
        type: "boolean",
        description: "Determine if MagicPrompt should be used in generating the request or not. Default value: true (Boolean value (true/false"
      },
      {
        name: "num_images",
        type: "string",
        enum: [
          "1",
          "2",
          "3",
          "4"
        ],
        default: "1",
        description: "Select description"
      }
    ],
    imageField: "reference_image_urls",
    imageMax: 10,
    imageSingle: false
  },
  {
    id: "ideogram/character-remix",
    label: "Character Remix",
    group: "Ideogram",
    docUrl: "https://docs.kie.ai/market/ideogram/character-remix",
    promptMax: 5000,
    options: [
      {
        name: "image_url",
        type: "string",
        required: true,
        description: "The image URL to remix (File URL after upload, not file content; Accepted types: image/jpeg, image/png, image/webp; Max"
      },
      {
        name: "reference_image_urls",
        type: "array",
        required: true,
        description: "A set of images to use as character references. Currently only 1 image is supported, rest will be ignored. (maximum tota"
      },
      {
        name: "rendering_speed",
        type: "string",
        enum: [
          "TURBO",
          "BALANCED",
          "QUALITY"
        ],
        default: "BALANCED",
        description: "The rendering speed to use. Default value: \"BALANCED\""
      },
      {
        name: "style",
        type: "string",
        enum: [
          "AUTO",
          "REALISTIC",
          "FICTION"
        ],
        default: "AUTO",
        description: "The style type to generate with. Cannot be used with style_codes. Default value: \"AUTO\""
      },
      {
        name: "expand_prompt",
        type: "boolean",
        description: "Determine if MagicPrompt should be used in generating the request or not. Default value: true (Boolean value (true/false"
      },
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9"
        ],
        default: "square_hd",
        description: "Select description"
      },
      {
        name: "num_images",
        type: "string",
        enum: [
          "1",
          "2",
          "3",
          "4"
        ],
        default: "1",
        description: "Select description"
      },
      {
        name: "strength",
        type: "number",
        default: 0.8,
        description: "Strength of the input image in the remix Default value: 0.8 (Min: 0.1, Max: 1, Step: 0.1) (step: 0.1)"
      },
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 500,
        description: "Description of what to exclude from an image. Descriptions in the prompt take precedence to descriptions in the negative"
      }
    ],
    imageField: "image_urls",
    imageMax: 10,
    imageSingle: false
  },
  {
    id: "ideogram/v3-edit",
    label: "Ideogram V3 Edit",
    group: "Ideogram",
    docUrl: "https://docs.kie.ai/market/ideogram/v3-edit",
    promptMax: 5000,
    options: [
      {
        name: "rendering_speed",
        type: "string",
        enum: [
          "TURBO",
          "BALANCED",
          "QUALITY"
        ],
        default: "BALANCED",
        description: "The rendering speed to use. Default value: `BALANCED`.\n\n- `TURBO`: Turbo\n- `BALANCED`: Balanced\n- `QUALITY`: Quality"
      },
      {
        name: "expand_prompt",
        type: "boolean",
        default: true,
        description: "Determine if MagicPrompt should be used in generating the request or not. Default value: `true`.\n\n- Boolean value: `true"
      }
    ],
    imageField: "image_url",
    imageMax: 1,
    imageSingle: true
  },
  {
    id: "ideogram/v3-remix",
    label: "Ideogram V3 Remix",
    group: "Ideogram",
    docUrl: "https://docs.kie.ai/market/ideogram/v3-remix",
    promptMax: 5000,
    options: [
      {
        name: "rendering_speed",
        type: "string",
        enum: [
          "TURBO",
          "BALANCED",
          "QUALITY"
        ],
        description: "The rendering speed to use.\n\n- `TURBO`: Turbo\n- `BALANCED`: Balanced\n- `QUALITY`: Quality"
      },
      {
        name: "style",
        type: "string",
        enum: [
          "AUTO",
          "GENERAL",
          "REALISTIC",
          "DESIGN"
        ],
        description: "The style type to generate with. Cannot be used together with `style_codes`.\n\n- `AUTO`: Auto\n- `GENERAL`: General\n- `REA"
      },
      {
        name: "expand_prompt",
        type: "boolean",
        description: "Determine if MagicPrompt should be used in generating the request or not.\n\n- Boolean value: `true` / `false`"
      },
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9"
        ],
        description: "The resolution of the generated image.\n\n- `square`: Square\n- `square_hd`: Square HD\n- `portrait_4_3`: Portrait 3:4\n- `po"
      },
      {
        name: "num_images",
        type: "string",
        enum: [
          "1",
          "2",
          "3",
          "4"
        ],
        description: "Number of images to generate.\n\n- `1`: 1 image\n- `2`: 2 images\n- `3`: 3 images\n- `4`: 4 images"
      },
      {
        name: "strength",
        type: "number",
        description: "Strength of the input image in the remix.\n\n- Minimum: `0.01`\n- Maximum: `1`\n- Step: `0.01`"
      },
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 5000,
        description: "Description of what to exclude from the generated image. If the positive prompt conflicts with the negative prompt, the"
      }
    ],
    imageField: "image_url",
    imageMax: 1,
    imageSingle: true
  },
  {
    id: "ideogram/v3-text-to-image",
    label: "Ideogram V3 Text to Image",
    group: "Ideogram",
    docUrl: "https://docs.kie.ai/market/ideogram/v3-text-to-image",
    promptMax: 5000,
    options: [
      {
        name: "rendering_speed",
        type: "string",
        enum: [
          "TURBO",
          "BALANCED",
          "QUALITY"
        ],
        description: "The rendering speed to use.\n\n- `TURBO`: Turbo\n- `BALANCED`: Balanced\n- `QUALITY`: Quality"
      },
      {
        name: "style",
        type: "string",
        enum: [
          "AUTO",
          "GENERAL",
          "REALISTIC",
          "DESIGN"
        ],
        description: "The style type to generate with. Cannot be used together with `style_codes`.\n\n- `AUTO`: Auto\n- `GENERAL`: General\n- `REA"
      },
      {
        name: "expand_prompt",
        type: "boolean",
        description: "Determines whether MagicPrompt should be used to enhance the generation request.\n\n- Boolean value: `true` / `false`"
      },
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9"
        ],
        description: "The resolution of the generated image.\n\n- `square`: Square\n- `square_hd`: Square HD\n- `portrait_4_3`: Portrait 3:4\n- `po"
      },
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 5000,
        description: "Description of what to exclude from the generated image. If the positive prompt conflicts with the negative prompt, the"
      }
    ]
  },
  {
    id: "gpt-image/1.5-image-to-image",
    label: "GPT Image-1.5 - Image to Image",
    group: "OpenAI",
    docUrl: "https://docs.kie.ai/market/gpt-image/1-5-image-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "2:3",
          "3:2"
        ],
        default: "3:2",
        required: true,
        description: "Width-height ratio of the image, determining its visual form."
      },
      {
        name: "quality",
        type: "string",
        enum: [
          "medium",
          "high"
        ],
        default: "medium",
        required: true,
        description: "Quality: medium=balanced, high=slow/detailed."
      }
    ],
    imageField: "input_urls",
    imageMax: 16,
    imageSingle: false
  },
  {
    id: "gpt-image/1.5-text-to-image",
    label: "GPT Image-1.5 - Text to Image",
    group: "OpenAI",
    docUrl: "https://docs.kie.ai/market/gpt-image/1-5-text-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "2:3",
          "3:2"
        ],
        default: "1:1",
        required: true,
        description: "Width-height ratio of the image, determining its visual form."
      },
      {
        name: "quality",
        type: "string",
        enum: [
          "medium",
          "high"
        ],
        default: "medium",
        required: true,
        description: "Quality: medium=balanced, high=slow/detailed."
      }
    ]
  },
  {
    id: "qwen2/image-edit",
    label: "Image Edit",
    group: "Qwen",
    docUrl: "https://docs.kie.ai/market/qwen2/image-edit",
    promptMax: 800,
    options: [
      {
        name: "image_size",
        type: "string",
        enum: [
          "1:1",
          "2:3",
          "3:2",
          "3:4",
          "4:3",
          "9:16",
          "16:9",
          "21:9"
        ],
        default: "16:9",
        description: "The size of the generated image. Default value: 16:9"
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "jpeg",
          "png"
        ],
        default: "png",
        description: "The format of the generated image. Default value: \"png\""
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "image_url",
    imageMax: 1,
    imageSingle: true
  },
  {
    id: "qwen/image-edit",
    label: "Image Edit",
    group: "Qwen",
    docUrl: "https://docs.kie.ai/market/qwen/image-edit",
    promptMax: 2000,
    options: [
      {
        name: "acceleration",
        type: "string",
        enum: [
          "none",
          "regular",
          "high"
        ],
        default: "none",
        description: "Acceleration level for image generation. Options: 'none', 'regular'. Higher acceleration increases speed. 'regular' bala"
      },
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9"
        ],
        default: "landscape_4_3",
        description: "The size of the generated image. Default value: landscape_4_3"
      },
      {
        name: "num_inference_steps",
        type: "number",
        default: 25,
        description: "The number of inference steps to perform. Default value: 30 (Min: 2, Max: 49, Step: 1) (step: 1)"
      },
      {
        name: "guidance_scale",
        type: "number",
        default: 4,
        description: "The CFG (Classifier Free Guidance) scale is a measure of how close you want the model to stick to your prompt when looki"
      },
      {
        name: "num_images",
        type: "string",
        enum: [
          "1",
          "2",
          "3",
          "4"
        ],
        description: "num_images"
      },
      {
        name: "enable_safety_checker",
        type: "boolean",
        description: "If set to true, the safety checker will be enabled. Default value: true (Boolean value (true/false))"
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "jpeg",
          "png"
        ],
        default: "png",
        description: "The format of the generated image. Default value: \"png\""
      },
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 500,
        description: "The negative prompt for the generation Default value: \" \" (Max length: 500 characters)"
      }
    ],
    imageField: "image_url",
    imageMax: 1,
    imageSingle: true
  },
  {
    id: "qwen/image-to-image",
    label: "Image to Image",
    group: "Qwen",
    docUrl: "https://docs.kie.ai/market/qwen/image-to-image",
    promptMax: 5000,
    options: [
      {
        name: "strength",
        type: "number",
        default: 0.8,
        description: "Denoising strength. 1.0 = fully remake; 0.0 = preserve original (Min: 0, Max: 1, Step: 0.01) (step: 0.01)"
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpeg"
        ],
        default: "png",
        description: "The format of the generated image"
      },
      {
        name: "acceleration",
        type: "string",
        enum: [
          "none",
          "regular",
          "high"
        ],
        default: "none",
        description: "Acceleration level for image generation. Options: 'none', 'regular', 'high'. Higher acceleration increases speed. 'regul"
      },
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 500,
        description: "The negative prompt for the generation (Max length: 500 characters)"
      },
      {
        name: "num_inference_steps",
        type: "number",
        default: 30,
        description: "The number of inference steps to perform (Min: 2, Max: 250, Step: 1) (step: 1)"
      },
      {
        name: "guidance_scale",
        type: "number",
        default: 2.5,
        description: "The CFG (Classifier Free Guidance) scale is a measure of how close you want the model to stick to your prompt when looki"
      },
      {
        name: "enable_safety_checker",
        type: "boolean",
        description: "The safety checker is always enabled in Playground. It can only be disabled by setting false through the API. (Boolean v"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "image_url",
    imageMax: 1,
    imageSingle: true
  },
  {
    id: "qwen/text-to-image",
    label: "Text to Image",
    group: "Qwen",
    docUrl: "https://docs.kie.ai/market/qwen/text-to-image",
    promptMax: 5000,
    options: [
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9"
        ],
        default: "square_hd",
        description: "The size of the generated image"
      },
      {
        name: "num_inference_steps",
        type: "number",
        default: 30,
        description: "The number of inference steps to perform (Min: 2, Max: 250, Step: 1) (step: 1)"
      },
      {
        name: "guidance_scale",
        type: "number",
        default: 2.5,
        description: "The CFG (Classifier Free Guidance) scale is a measure of how close you want the model to stick to your prompt when looki"
      },
      {
        name: "enable_safety_checker",
        type: "boolean",
        description: "The safety checker is always enabled in Playground. It can only be disabled by setting false through the API. (Boolean v"
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpeg"
        ],
        default: "png",
        description: "The format of the generated image"
      },
      {
        name: "negative_prompt",
        type: "string",
        maxLength: 500,
        description: "The negative prompt for the generation (Max length: 500 characters)"
      },
      {
        name: "acceleration",
        type: "string",
        enum: [
          "none",
          "regular",
          "high"
        ],
        default: "none",
        description: "Acceleration level for image generation. Options: 'none', 'regular', 'high'. Higher acceleration increases speed. 'regul"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ]
  },
  {
    id: "seedream/4.5-edit",
    label: "Edit",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream/4-5-edit",
    promptMax: 3000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "2:3",
          "3:2",
          "21:9"
        ],
        default: "1:1",
        required: true,
        description: "Width-height ratio of the image, determining its visual form."
      },
      {
        name: "quality",
        type: "string",
        enum: [
          "basic",
          "high"
        ],
        default: "basic",
        required: true,
        description: "Basic outputs 2K images, while High outputs 4K images."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "image_urls",
    imageMax: 14,
    imageSingle: false
  },
  {
    id: "bytedance/seedream-v4-edit",
    label: "Edit",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream/seedream-v4-edit",
    promptMax: 5000,
    options: [
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_3_2",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_3_2",
          "landscape_16_9",
          "landscape_21_9"
        ],
        default: "square_hd",
        description: "The size of the generated image."
      },
      {
        name: "image_resolution",
        type: "string",
        enum: [
          "1K",
          "2K",
          "4K"
        ],
        default: "1K",
        description: "Final image resolution is determined by combining image_size (aspect ratio) and image_resolution (pixel scale). For exam"
      },
      {
        name: "max_images",
        type: "number",
        default: 1,
        description: "Set this value (1\u20136) to cap how many images a single generation run can produce in one set\u2014because they\u2019re created in on"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "image_urls",
    imageMax: 10,
    imageSingle: false
  },
  {
    id: "seedream/5-lite-image-to-image",
    label: "Image to Image",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream-5-lite-image-to-image",
    promptMax: 3000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "2:3",
          "3:2",
          "21:9"
        ],
        default: "1:1",
        required: true,
        description: "Width-height ratio of the image, determining its visual form."
      },
      {
        name: "quality",
        type: "string",
        enum: [
          "basic",
          "high",
          "ultra"
        ],
        default: "basic",
        required: true,
        description: "Basic outputs 2K images, while High outputs 3K images, and Ultra outputs 4K images."
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpeg"
        ],
        default: "png",
        description: "Format of the output image"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "image_urls",
    imageMax: 14,
    imageSingle: false
  },
  {
    id: "seedream/5-pro-image-to-image",
    label: "Image to Image",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream/5-pro-image-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "2:3",
          "3:2",
          "21:9"
        ],
        default: "1:1",
        required: true,
        description: "Width-height ratio of the image, determining its visual form."
      },
      {
        name: "quality",
        type: "string",
        enum: [
          "basic",
          "high"
        ],
        default: "basic",
        required: true,
        description: "Basic outputs 1K images, while High outputs 2K images."
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpeg"
        ],
        default: "png",
        description: "Format of the output image"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "image_urls",
    imageMax: 10,
    imageSingle: false
  },
  {
    id: "seedream/4.5-text-to-image",
    label: "Text to Image",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream/4-5-text-to-image",
    promptMax: 3000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "2:3",
          "3:2",
          "21:9"
        ],
        default: "1:1",
        required: true,
        description: "Width-height ratio of the image, determining its visual form."
      },
      {
        name: "quality",
        type: "string",
        enum: [
          "basic",
          "high"
        ],
        default: "basic",
        required: true,
        description: "Basic outputs 2K images, while High outputs 4K images."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ]
  },
  {
    id: "seedream/5-lite-text-to-image",
    label: "Text to Image",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream/5-lite-text-to-image",
    promptMax: 3000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "2:3",
          "3:2",
          "21:9"
        ],
        default: "1:1",
        required: true,
        description: "Width-height ratio of the image, determining its visual form."
      },
      {
        name: "quality",
        type: "string",
        enum: [
          "basic",
          "high",
          "ultra"
        ],
        default: "basic",
        required: true,
        description: "Basic outputs 2K images, while High outputs 3K images, and Ultra outputs 4K images."
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpeg"
        ],
        default: "png",
        description: "Format of the output image"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ]
  },
  {
    id: "seedream/5-pro-text-to-image",
    label: "Text to Image",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream/5-pro-text-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16",
          "2:3",
          "3:2",
          "21:9"
        ],
        default: "1:1",
        required: true,
        description: "Width-height ratio of the image, determining its visual form."
      },
      {
        name: "quality",
        type: "string",
        enum: [
          "basic",
          "high"
        ],
        default: "basic",
        required: true,
        description: "Basic outputs 1K images, while High outputs 2K images."
      },
      {
        name: "output_format",
        type: "string",
        enum: [
          "png",
          "jpeg"
        ],
        default: "png",
        description: "Format of the output image"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ]
  },
  {
    id: "bytedance/seedream-v4-text-to-image",
    label: "Text to Image",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream/seedream-v4-text-to-image",
    promptMax: 5000,
    options: [
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_3_2",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_3_2",
          "landscape_16_9",
          "landscape_21_9"
        ],
        default: "square_hd",
        description: "The size of the generated image."
      },
      {
        name: "image_resolution",
        type: "string",
        enum: [
          "1K",
          "2K",
          "4K"
        ],
        default: "1K",
        description: "Final image resolution is determined by combining image_size (aspect ratio) and image_resolution (pixel scale). For exam"
      },
      {
        name: "max_images",
        type: "number",
        default: 1,
        description: "Set this value (1\u20136) to cap how many images a single generation run can produce in one set\u2014because they\u2019re created in on"
      }
    ]
  },
  {
    id: "bytedance/seedream",
    label: "Text to Image",
    group: "Seedream",
    docUrl: "https://docs.kie.ai/market/seedream/seedream",
    promptMax: 5000,
    options: [
      {
        name: "image_size",
        type: "string",
        enum: [
          "square",
          "square_hd",
          "portrait_4_3",
          "portrait_16_9",
          "landscape_4_3",
          "landscape_16_9"
        ],
        default: "square_hd",
        description: "Select description"
      },
      {
        name: "guidance_scale",
        type: "number",
        default: 2.5,
        description: "Controls how closely the output image aligns with the input prompt. Higher values mean stronger prompt correlation. (Min"
      }
    ]
  },
  {
    id: "wan/2-7-image",
    label: "Wan 2.7 Image",
    group: "Wan",
    docUrl: "https://docs.kie.ai/market/wan/2-7-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "16:9",
          "4:3",
          "21:9",
          "3:4",
          "9:16",
          "8:1",
          "1:8"
        ],
        description: "(Optional) Output aspect ratio when no image input is provided."
      },
      {
        name: "enable_sequential",
        type: "boolean",
        default: false,
        description: "Whether to enable sequential/group image mode. Default is false."
      },
      {
        name: "n",
        type: "integer",
        description: "Number of images to generate. Range is 1-4 when `enable_sequential=false` (default: 4); range is 1-12 when `enable_seque"
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K",
          "4K"
        ],
        default: "2K",
        description: "Output resolution. The current project uses `resolution` as a wrapper field corresponding to the underlying resolution p"
      },
      {
        name: "thinking_mode",
        type: "boolean",
        default: false,
        description: "Whether to enable thinking mode. Only available when `enable_sequential=false` and `input_urls` is empty; the frontend w"
      },
      {
        name: "color_palette",
        type: "array",
        description: "(Optional) Custom color theme. Only available when `enable_sequential=false`. Requires 3-10 colors, 8 recommended."
      },
      {
        name: "watermark",
        type: "boolean",
        default: false,
        description: "Whether to add watermark."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "input_urls",
    imageMax: 9,
    imageSingle: false
  },
  {
    id: "wan/2-7-image-pro",
    label: "Wan 2.7 Image Pro",
    group: "Wan",
    docUrl: "https://docs.kie.ai/market/wan/2-7-image-pro",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "16:9",
          "4:3",
          "21:9",
          "3:4",
          "9:16",
          "8:1",
          "1:8"
        ],
        description: "(Optional) Output aspect ratio when no image input is provided."
      },
      {
        name: "enable_sequential",
        type: "boolean",
        default: false,
        description: "Whether to enable sequential/group image mode. Default is false."
      },
      {
        name: "n",
        type: "integer",
        description: "Number of images to generate. Range is 1-4 when `enable_sequential=false` (default: 4); range is 1-12 when `enable_seque"
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K",
          "4K"
        ],
        default: "2K",
        description: "Output resolution. The current project uses `resolution` as a wrapper field corresponding to the underlying resolution p"
      },
      {
        name: "thinking_mode",
        type: "boolean",
        default: false,
        description: "Whether to enable thinking mode. Only available when `enable_sequential=false` and `input_urls` is empty; the frontend w"
      },
      {
        name: "color_palette",
        type: "array",
        description: "(Optional) Custom color theme. Only available when `enable_sequential=false`. Requires 3-10 colors, 8 recommended."
      },
      {
        name: "watermark",
        type: "boolean",
        default: false,
        description: "Whether to add watermark."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "input_urls",
    imageMax: 9,
    imageSingle: false
  },
  {
    id: "z-image",
    label: "Z-Image",
    group: "Z-Image",
    docUrl: "https://docs.kie.ai/market/z-image/z-image",
    promptMax: 1000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "1:1",
          "4:3",
          "3:4",
          "16:9",
          "9:16"
        ],
        default: "1:1",
        required: true,
        description: "Aspect ratio for the generated image. Select 'auto' to match the first input image ratio (requires input image)."
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ]
  },
  {
    id: "gpt-image-2-image-to-image",
    label: "Image To Image",
    group: "gpt-image-2-image-to-image",
    docUrl: "https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "auto",
          "1:1",
          "3:2",
          "2:3",
          "4:3",
          "3:4",
          "5:4",
          "4:5",
          "16:9",
          "9:16",
          "2:1",
          "1:2",
          "3:1",
          "1:3",
          "21:9",
          "9:21"
        ],
        description: "The aspect ratio of the generated image is set to auto by default.\nNote: 5:4 and 4:5 aspect ratios only support 1K image"
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K",
          "4K"
        ],
        description: "Image resolution: Note: Images with a 1:1 aspect ratio cannot be converted to 4K images. Images with the aspect ratio se"
      }
    ],
    imageField: "input_urls",
    imageMax: 16,
    imageSingle: false
  },
  {
    id: "gpt-image-2-text-to-image",
    label: "GPT Image-2 - Text to Image",
    group: "gpt-image-2-text-to-image",
    docUrl: "https://docs.kie.ai/market/gpt/gpt-image-2-text-to-image",
    promptMax: 20000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "auto",
          "1:1",
          "3:2",
          "2:3",
          "4:3",
          "3:4",
          "5:4",
          "4:5",
          "16:9",
          "9:16",
          "2:1",
          "1:2",
          "3:1",
          "1:3",
          "21:9",
          "9:21"
        ],
        description: "The aspect ratio of the generated image is set to auto by default.\nNote: for 2K and 4K resolution, the following aspect"
      },
      {
        name: "resolution",
        type: "string",
        enum: [
          "1K",
          "2K",
          "4K"
        ],
        description: "Image resolution: Note: Images with a 1:1 aspect ratio cannot be converted to 4K images. Images with the aspect ratio se"
      }
    ]
  },
  {
    id: "grok-imagine/text-to-image",
    label: "Text to Image",
    group: "xAI",
    docUrl: "https://docs.kie.ai/market/grok-imagine/text-to-image",
    promptMax: 5000,
    options: [
      {
        name: "aspect_ratio",
        type: "string",
        enum: [
          "2:3",
          "3:2",
          "1:1",
          "16:9",
          "9:16"
        ],
        description: "Specifies the width-to-height ratio of the generated image. Controls the aspect ratio of the output.\n\n- **2:3**: Portrai"
      },
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      },
      {
        name: "enable_pro",
        type: "boolean",
        description: "Controls the request processing strategy.  \n  - `false`: Corresponds to **speed mode**. The system prioritizes response"
      }
    ]
  },
  {
    id: "grok-imagine/image-to-image",
    label: "image to image",
    group: "xAI",
    docUrl: "https://docs.kie.ai/market/grok-imagine/image-to-image",
    promptMax: 390000,
    options: [
      {
        name: "nsfw_checker",
        type: "boolean",
        description: "Defaults to false. You can set it to false based on your needs. If set to false, our content filtering will be disabled,"
      }
    ],
    imageField: "image_urls",
    imageMax: 5,
    imageSingle: false
  }
];
