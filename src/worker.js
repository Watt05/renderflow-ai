const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "WRENDERFLOW", engine: MODEL });
    }

    if (url.pathname === "/api/render") {
      if (request.method !== "POST") return json({ error: "Use POST for rendering." }, 405);
      if (!env.AI) return json({ error: "Workers AI binding is missing. Add the AI binding and redeploy." }, 503);

      try {
        const form = await request.formData();
        const file = form.get("image");
        if (!(file instanceof File)) return json({ error: "Please upload a PNG, JPG, or WEBP image." }, 400);
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
          return json({ error: "Only PNG, JPG, and WEBP images are supported." }, 400);
        }
        if (file.size > 15 * 1024 * 1024) return json({ error: "The image must be 15 MB or smaller." }, 413);

        const style = String(form.get("style") || "Photorealistic").slice(0, 80);
        const view = String(form.get("view") || "Keep original camera").slice(0, 80);
        const lighting = String(form.get("lighting") || "Natural daylight").slice(0, 80);
        const instructions = String(form.get("instructions") || "").slice(0, 1200);
        const preserve = form.get("preserve") === "true";

        const styleGuidance = style === "D5-inspired photorealism"
          ? "D5 Render-inspired architectural visualization: premium physically based materials, realistic global illumination, soft ambient occlusion, balanced exposure, crisp but natural details, realistic vegetation, subtle warm architectural lighting, high-end professional archviz finish. Avoid over-sharpening, plastic surfaces, excessive bloom, and artificial saturation."
          : style === "Khmer-inspired contemporary"
          ? "Subtle contemporary Khmer architectural identity, authentic Khmer proportions and restrained motifs, elegant reinterpretation of Khmer roof lines and screens where already present, refined local stone and timber palette. Avoid Thai temple styling, ornate clichés, or changing the building massing."
          : "Professional architectural visualization with physically based materials, believable roughness and reflectivity, realistic glass, stone, timber, metal, refined landscaping, balanced exposure and natural color grading.";

        const prompt = [
          "EDIT the supplied reference image as an architectural material-and-light enhancement, not as a new design generation.",
          "IMAGE 0 IS THE AUTHORITATIVE DESIGN. Maintain one-to-one spatial correspondence with the reference: same framing, crop, camera position, perspective, horizon, silhouette and placement of every visible element.",
          "This is not a redesign. Do not reinterpret the architecture, simplify it, complete hidden areas, or invent missing details.",
          "Rendering style: " + style + ".",
          "Camera/view: " + view + ".",
          "Lighting: " + lighting + ".",
          styleGuidance,
          preserve
            ? "HARD GEOMETRY LOCK: preserve the exact pixel-space position and shape of the building silhouette, every roof edge, column, beam, wall, stair, railing, door, window, opening, furniture item and visible site element. Keep the exact number of floors and all proportions. Do not add, remove, move, resize, straighten, curve, or replace any architectural element. No crop, zoom, pan, lens change, perspective correction or camera shift. Change ONLY the surface appearance of existing surfaces: material texture, roughness, color, glass reflections, illumination and shadows. Keep the existing background and landscape; do not add new plants, people, objects or context unless explicitly requested."
            : "Respect the supplied design while creating a refined architectural interpretation.",
          "Use physically plausible materials, realistic glass reflections, natural shadows, accurate material scale, detailed but restrained landscaping, subtle contact shadows, coherent perspective and professional architectural photography composition.",
          instructions
        ].filter(Boolean).join(" ");

        const outputWidth = Math.min(1920, Math.max(256, Number(form.get("outputWidth")) || 1024));
        const outputHeight = Math.min(1920, Math.max(256, Number(form.get("outputHeight")) || 768));

        // FLUX.2 [klein] 4B requires multipart input, including the reference image.
        const modelForm = new FormData();
        modelForm.append("prompt", prompt);
        modelForm.append("input_image_0", file, file.name || "reference.jpg");
        modelForm.append("width", String(outputWidth));
        modelForm.append("height", String(outputHeight));
        modelForm.append("guidance", preserve ? "2.5" : "4");

        // Let Response serialize FormData so the multipart boundary is included.
        const multipartRequest = new Response(modelForm);
        const result = await env.AI.run(MODEL, {
          multipart: {
            body: multipartRequest.body,
            contentType: multipartRequest.headers.get("content-type")
          }
        });

        if (result instanceof Response) {
          if (!result.ok) {
            const detail = await result.text();
            return json({ error: "Workers AI request failed: " + detail.slice(0, 500) }, 502);
          }
          const headers = new Headers(result.headers);
          headers.set("content-type", "image/png");
          headers.set("cache-control", "no-store");
          return new Response(result.body, { status: 200, headers });
        }

        const imageData = typeof result === "string" ? result : (result?.image ?? result);
        const imageHeaders = { "content-type": "image/png", "cache-control": "no-store" };

        if (typeof imageData === "string" && imageData.length > 0) {
          return new Response(base64ToBytes(imageData), { headers: imageHeaders });
        }
        if (imageData instanceof Uint8Array) {
          return new Response(imageData, { headers: imageHeaders });
        }
        if (imageData instanceof ArrayBuffer) {
          return new Response(imageData, { headers: imageHeaders });
        }
        if (ArrayBuffer.isView(imageData)) {
          return new Response(new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength), { headers: imageHeaders });
        }
        if (imageData instanceof Blob) {
          return new Response(imageData, { headers: imageHeaders });
        }

        return json({
          error: result?.error || "The rendering model returned an unsupported image response."
        }, 502);
      } catch (error) {
        console.error("WRENDERFLOW generation error:", error);
        return json({ error: error?.message || "Rendering failed. Please try again." }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
