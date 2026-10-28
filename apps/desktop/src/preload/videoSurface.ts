import { ipcRenderer, sharedTexture } from "electron";

let canvas: HTMLCanvasElement | null = null;
let gl: WebGL2RenderingContext | null = null;
let generation = 0;
let observer: MutationObserver | null = null;

const fail = (cause: unknown): void => {
  ipcRenderer.send(
    "video:status",
    generation,
    cause instanceof Error ? cause.message : String(cause),
  );
};

if (process.platform === "win32") {
  ipcRenderer.on("video:generation", (_event, value: number) => {
    generation = value;
    if (gl) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  });
  sharedTexture.setSharedTextureReceiver(
    async ({ importedSharedTexture }, frameGeneration: number) => {
      let frame: VideoFrame | undefined;
      try {
        if (frameGeneration !== generation) return;
        if (!canvas?.isConnected || !gl || gl.isContextLost())
          throw new Error("The GPU video surface is unavailable");
        frame = importedSharedTexture.getVideoFrame();
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.flush();
        if (gl.getError() !== gl.NO_ERROR) throw new Error("GPU video drawing failed");
        ipcRenderer.send("video:status", generation, null);
      } catch (cause) {
        fail(cause);
      } finally {
        frame?.close();
        importedSharedTexture.release();
      }
    },
  );
}

/** Called before the main-process surface handshake; native objects never cross contextBridge. */
export const prepareVideoSurface = (): void => {
  if (process.platform !== "win32") return;
  if (canvas?.isConnected && gl && !gl.isContextLost()) return;
  releaseVideoSurface();
  const element = document.querySelector("[data-lumen-video-surface]");
  if (!element) throw new Error("Video surface element is missing");
  canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block;pointer-events:none";
  element.replaceChildren(canvas);
  observer = new MutationObserver(() => {
    if (!canvas?.isConnected) {
      fail(new Error("Video surface was removed"));
      releaseVideoSurface();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  let creationError = "";
  canvas.addEventListener(
    "webglcontextcreationerror",
    (event) => {
      creationError = (event as WebGLContextEvent).statusMessage;
    },
    { once: true },
  );
  gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) throw new Error(`Hardware WebGL2 is required for video playback: ${creationError}`);
  const context = gl;
  canvas.addEventListener(
    "webglcontextlost",
    () => {
      if (gl === context) fail(new Error("Video GPU context was lost"));
    },
    { once: true },
  );
  const shader = (type: number, source: string): WebGLShader => {
    const value = context.createShader(type);
    if (!value) throw new Error("Cannot allocate video shader");
    context.shaderSource(value, source);
    context.compileShader(value);
    if (!context.getShaderParameter(value, context.COMPILE_STATUS))
      throw new Error("Cannot compile video shader");
    return value;
  };
  const vertex = shader(
    context.VERTEX_SHADER,
    `#version 300 es
    out vec2 uv;
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      uv = vec2(p.x, 1.0-p.y);
      gl_Position = vec4(p*2.0-1.0, 0, 1);
    }`,
  );
  const fragment = shader(
    context.FRAGMENT_SHADER,
    `#version 300 es
    precision highp float;
    uniform sampler2D video;
    in vec2 uv;
    out vec4 color;
    void main() { color = texture(video, uv); }`,
  );
  const program = context.createProgram();
  if (!program) throw new Error("Cannot allocate video program");
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  context.deleteShader(vertex);
  context.deleteShader(fragment);
  if (!context.getProgramParameter(program, context.LINK_STATUS))
    throw new Error("Cannot link video program");
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
  context.useProgram(program);
  const texture = context.createTexture();
  if (!texture) throw new Error("Cannot allocate video texture");
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
};

export const releaseVideoSurface = (): void => {
  observer?.disconnect();
  observer = null;
  const previous = gl;
  gl = null;
  previous?.getExtension("WEBGL_lose_context")?.loseContext();
  canvas?.remove();
  canvas = null;
};
