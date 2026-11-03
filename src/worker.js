const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
function base64ToBytes(value) {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function digest(value) {
  const data = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(data)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 210000, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function cookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const item = raw.split(";").map(x => x.trim()).find(x => x.startsWith(name + "="));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}
function sessionCookie(value, maxAge) {
  return "wf_session=" + encodeURIComponent(value) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}
function oauthCookie(value, maxAge) {
  return "wf_oauth_state=" + encodeURIComponent(value) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}
function validOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
async function currentUser(request, env) {
  if (!env.DB) return null;
  const token = cookie(request, "wf_session");
  if (!token) return null;
  const row = await env.DB.prepare("SELECT users.id, users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?").bind(await digest(token), Math.floor(Date.now()/1000)).first();
  return row || null;
}
async function googleAuthRoute(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({error:"Google sign-in is not configured yet."},503);
  const redirectUri = new URL("/api/auth/google/callback", url.origin).toString();
  if (url.pathname === "/api/auth/google" && request.method === "GET") {
    const state=randomToken(24), target=new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.searchParams.set("client_id",env.GOOGLE_CLIENT_ID); target.searchParams.set("redirect_uri",redirectUri);
    target.searchParams.set("response_type","code"); target.searchParams.set("scope","openid email profile");
    target.searchParams.set("state",state); target.searchParams.set("prompt","select_account");
    return new Response(null,{status:302,headers:{"location":target.toString(),"set-cookie":oauthCookie(state,600),"cache-control":"no-store"}});
  }
  if (url.pathname !== "/api/auth/google/callback") return json({error:"Not found."},404);
  const state=url.searchParams.get("state")||"";
  if (!state || state!==cookie(request,"wf_oauth_state") || !url.searchParams.get("code")) return new Response("Google sign-in could not be verified. Please try again.",{status:400,headers:{"set-cookie":oauthCookie("",0)}});
  if (!env.DB) return new Response("Account database is not configured. Please continue as a guest.",{status:503,headers:{"set-cookie":oauthCookie("",0)}});
  const tr=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code:url.searchParams.get("code"),client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:redirectUri,grant_type:"authorization_code"})});
  const tokens=await tr.json();
  if (!tr.ok || !tokens.access_token) return new Response("Google authentication failed. Please try again.",{status:401,headers:{"set-cookie":oauthCookie("",0)}});
  const pr=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{authorization:"Bearer "+tokens.access_token}});
  const profile=await pr.json();
  if (!pr.ok || !profile.sub || !profile.email || profile.email_verified!==true) return new Response("Google did not provide a verified email address.",{status:401,headers:{"set-cookie":oauthCookie("",0)}});
  let user=await env.DB.prepare("SELECT id,email FROM users WHERE google_sub=?").bind(profile.sub).first();
  if (!user) {
    user=await env.DB.prepare("SELECT id,email FROM users WHERE email=?").bind(String(profile.email).toLowerCase()).first();
    if (user) await env.DB.prepare("UPDATE users SET google_sub=? WHERE id=?").bind(profile.sub,user.id).run();
    else { const id=crypto.randomUUID(),salt=randomToken(16),hash=await passwordHash(randomToken(48),salt);
      await env.DB.prepare("INSERT INTO users (id,email,password_hash,password_salt,google_sub,created_at) VALUES (?,?,?,?,?,?)").bind(id,String(profile.email).toLowerCase(),hash,salt,profile.sub,Math.floor(Date.now()/1000)).run();
      user={id,email:String(profile.email).toLowerCase()};
    }
  }
  const session=randomToken();
  await env.DB.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),user.id,await digest(session),Math.floor(Date.now()/1000)+SESSION_SECONDS,Math.floor(Date.now()/1000)).run();
  const headers = new Headers({"location":url.origin+"/","cache-control":"no-store"});
  headers.append("set-cookie",sessionCookie(session,SESSION_SECONDS));
  headers.append("set-cookie",oauthCookie("",0));
  return new Response(null,{status:302,headers});
}
async function authRoute(request, env, path) {
  if (!env.DB) return json({ error: "Account service is not configured yet. Please continue as a guest." }, 503);
  if (path === "/api/auth/me" && request.method === "GET") {
    const user = await currentUser(request, env);
    return json({ user: user ? { id: user.id, email: user.email } : null });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    if (!validOrigin(request)) return json({ error: "Invalid request origin." }, 403);
    const token = cookie(request, "wf_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }
  if (path !== "/api/auth/login" && path !== "/api/auth/signup") return json({ error: "Not found." }, 404);
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!validOrigin(request)) return json({ error: "Invalid request origin." }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400);
  if (password.length < 10 || password.length > 128) return json({ error: "Password must be between 10 and 128 characters." }, 400);
  let user;
  if (path.endsWith("/signup")) {
    const id = crypto.randomUUID(), salt = randomToken(16), hash = await passwordHash(password, salt);
    try {
      await env.DB.prepare("INSERT INTO users (id,email,password_hash,password_salt,created_at) VALUES (?,?,?,?,?)").bind(id,email,hash,salt,Math.floor(Date.now()/1000)).run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return json({ error: "An account with this email already exists. Please log in." }, 409);
      throw error;
    }
    user = { id, email };
  } else {
    const row = await env.DB.prepare("SELECT id,email,password_hash,password_salt FROM users WHERE email=?").bind(email).first();
    if (!row) return json({ error: "Email or password is incorrect." }, 401);
    const candidate = await passwordHash(password, row.password_salt);
    if (candidate !== row.password_hash) return json({ error: "Email or password is incorrect." }, 401);
    user = { id: row.id, email: row.email };
  }
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),user.id,await digest(token),Math.floor(Date.now()/1000)+SESSION_SECONDS,Math.floor(Date.now()/1000)).run();
  return json({ ok: true, user }, 200, { "set-cookie": sessionCookie(token, SESSION_SECONDS) });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return json({ ok: true, service: "WRENDERFLOW", engine: MODEL, accounts: !!env.DB });
      if (url.pathname === "/api/auth/google" || url.pathname === "/api/auth/google/callback") return await googleAuthRoute(request, env, url);
      if (url.pathname.startsWith("/api/auth/")) return await authRoute(request, env, url.pathname);
      if (url.pathname === "/api/render") {
        if (request.method !== "POST") return json({ error: "Use POST for rendering." }, 405);
        if (!env.AI) return json({ error: "Workers AI binding is missing. Add the AI binding and redeploy." }, 503);
        const form = await request.formData();
        const file = form.get("image");
        if (!(file instanceof File)) return json({ error: "Please upload a PNG, JPG, or WEBP image." }, 400);
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return json({ error: "Only PNG, JPG, and WEBP images are supported." }, 400);
        if (file.size > 15 * 1024 * 1024) return json({ error: "The image must be 15 MB or smaller." }, 413);
        const style = String(form.get("style") || "Photorealistic").slice(0,80);
        const view = String(form.get("view") || "Keep original camera").slice(0,80);
        const lighting = String(form.get("lighting") || "Natural daylight").slice(0,80);
        const instructions = String(form.get("instructions") || "").slice(0,1800);
        const materialPreset = String(form.get("materialPreset") || "").slice(0,700);
        const lightingPreset = String(form.get("lightingPreset") || lighting).slice(0,300);
        const preserve = form.get("preserve") === "true";
        const preserveStrength = Math.max(0,Math.min(100,Number(form.get("preserveStrength")) || 0));
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
          "Material direction: " + materialPreset + ". Apply the selected material only to appropriate existing surfaces and elements. Preserve the reference image material boundaries and do not convert the whole building into one material. Do not create new cladding, windows, screens, frames or architectural details.",
          "Lighting treatment: " + lightingPreset + ". Match the selected atmosphere while keeping believable exposure, physically plausible shadow direction, realistic interior/exterior light balance, and preserving all original geometry.",
          styleGuidance,
          preserve ? (preserveStrength >= 80
            ? "STRICT STRUCTURE LOCK ("+preserveStrength+"%): preserve the exact silhouette, roof geometry, roof pitch, edges, columns, beams, walls, stairs, railings, doors, windows, openings, floor count, proportions, site elements, crop, camera position, perspective and framing. Do not add, remove, move, resize, complete, redesign or replace any architectural element. Change only material appearance, surface texture, reflectivity, illumination and shadows."
            : "STRUCTURE PRESERVATION ("+preserveStrength+"%): strongly retain original massing, rooflines, openings, floor count, proportions, layout and camera framing. Do not redesign or invent architectural elements.")
            : "Respect the supplied design while creating a refined architectural interpretation.",
          "Use physically plausible materials, realistic glass reflections, natural shadows, accurate material scale, detailed but restrained landscaping, subtle contact shadows, coherent perspective and professional architectural photography composition.",
          instructions
        ].filter(Boolean).join(" ");
        const outputWidth = Math.min(1920,Math.max(256,Number(form.get("outputWidth")) || 1024));
        const outputHeight = Math.min(1920,Math.max(256,Number(form.get("outputHeight")) || 768));
        const modelForm = new FormData();
        modelForm.append("prompt",prompt); modelForm.append("input_image_0",file,file.name || "reference.jpg");
        modelForm.append("width",String(outputWidth)); modelForm.append("height",String(outputHeight));
        modelForm.append("guidance",preserve ? "2.5" : "4");
        const multipartRequest = new Response(modelForm);
        const result = await env.AI.run(MODEL,{multipart:{body:multipartRequest.body,contentType:multipartRequest.headers.get("content-type")}});
        if (result instanceof Response) {
          if (!result.ok) return json({error:"Workers AI request failed: "+(await result.text()).slice(0,500)},502);
          const headers = new Headers(result.headers); headers.set("content-type","image/png"); headers.set("cache-control","no-store");
          return new Response(result.body,{status:200,headers});
        }
        const imageData = typeof result === "string" ? result : (result?.image ?? result);
        const imageHeaders = {"content-type":"image/png","cache-control":"no-store"};
        if (typeof imageData === "string" && imageData.length) return new Response(base64ToBytes(imageData),{headers:imageHeaders});
        if (imageData instanceof Uint8Array || imageData instanceof ArrayBuffer || ArrayBuffer.isView(imageData) || imageData instanceof Blob) {
          return new Response(imageData instanceof ArrayBuffer ? imageData : imageData instanceof Uint8Array ? imageData : ArrayBuffer.isView(imageData) ? new Uint8Array(imageData.buffer,imageData.byteOffset,imageData.byteLength) : imageData,{headers:imageHeaders});
        }
        return json({error:result?.error || "The rendering model returned an unsupported image response."},502);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("WRENDERFLOW request error:",error);
      return json({error:error?.message || "Request failed. Please try again."},500);
    }
  }
};
