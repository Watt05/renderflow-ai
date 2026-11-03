function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "RenderFlow AI", engine: "@cf/runwayml/stable-diffusion-v1-5-img2img" });
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

        const prompt = [
          "Photorealistic architectural visualization based on the supplied reference image.",
          "Style: " + style + ".",
          "Lighting: " + lighting + ".",
          "View: " + view + ".",
          preserve ? "Preserve the original building design, silhouette, geometry, proportions, openings, structural layout, composition and camera viewpoint as closely as possible. Do not redesign the architecture." : "Create an architectural interpretation while respecting the reference image.",
          "Use physically plausible materials, realistic reflections, natural shadows, detailed but restrained landscaping, professional architectural photography.",
          instructions
        ].filter(Boolean).join(" ");

        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await env.AI.run("@cf/runwayml/stable-diffusion-v1-5-img2img", {
          prompt,
          negative_prompt: "different building, changed geometry, distorted perspective, warped lines, extra floors, missing windows, text, watermark, logo, blurry, low quality, cartoon, illustration",
          image_b64: bytesToBase64(bytes),
          strength: preserve ? 0.35 : 0.65,
          guidance: 7.5,
          num_steps: 20
        });

        if (result instanceof Response) {
          const headers = new Headers(result.headers);
          headers.set("content-type", "image/png");
          headers.set("cache-control", "no-store");
          return new Response(result.body, { status: result.status, headers });
        }
        if (result instanceof ReadableStream || result instanceof Uint8Array) {
          return new Response(result, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
        }
        if (typeof result === "string") {
          const binary = atob(result);
          const output = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) output[i] = binary.charCodeAt(i);
          return new Response(output, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
        }
        if (result && typeof result.image === "string") {
          const binary = atob(result.image);
          const output = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) output[i] = binary.charCodeAt(i);
          return new Response(output, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
        }
        return json({ error: "The rendering service returned an unexpected response." }, 502);
      } catch (error) {
        console.error("RenderFlow generation error:", error);
        return json({ error: error?.message || "Rendering failed. Please try again." }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
