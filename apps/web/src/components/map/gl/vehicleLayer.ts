/**
 * A járművek WebGL-rétege: minden csempe egy négyszög, egyetlen rajzolással (instancing).
 * A régi ~400 HTML-jelölő minden képkockán külön elhelyezése (és a térkép mozgása közbeni
 * lemaradása, „csúszása”) helyett a csempék a térképpel egy képkockában, a GPU-n készülnek.
 * A helyüket képkockánként a `collect` adja (a mozgásbecslés), a képük a `BadgeAtlas`-ból jön.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from "maplibre-gl";
import { ATLAS_SIZE, type AtlasEntry, type BadgeAtlas } from "./badges";

/** egy kirajzolandó kép: a jármű helye (Mercator 0..1, z: magasság Mercator-egységben) */
export interface Sprite {
  mx: number;
  my: number;
  mz: number;
  entry: AtlasEntry;
  alpha: number;
}

/** instance-onként: pos (3) + uv (4) + box (4) + alpha (1) */
const FLOATS = 12;

const VERT = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_scale;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_pos;
layout(location = 2) in vec4 a_uv;
layout(location = 3) in vec4 a_box;
layout(location = 4) in float a_alpha;
out vec2 v_uv;
out float v_alpha;
void main() {
  vec4 c = u_matrix * vec4(a_pos, 1.0);
  if (c.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // a jármű pontja képernyő-pixelre igazítva: a csempe képe 1:1-ben, élesen kerül ki
  vec2 px = floor((c.xy / c.w * 0.5 + 0.5) * u_viewport + 0.5);
  vec2 off = (a_box.xy + a_corner * a_box.zw) * u_scale;
  px += vec2(off.x, -off.y);
  gl_Position = vec4(px / u_viewport * 2.0 - 1.0, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_alpha = a_alpha;
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
in float v_alpha;
out vec4 color;
void main() {
  color = texture(u_tex, v_uv) * v_alpha;
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("shader");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
  return sh;
}

type GLState = {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
  corners: WebGLBuffer;
  texture: WebGLTexture;
  uMatrix: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
  uTex: WebGLUniformLocation | null;
  capacity: number;
};

export class VehicleLayer implements CustomLayerInterface {
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  private st: GLState | null = null;
  private data = new Float32Array(FLOATS * 512);
  private sprites: Sprite[] = [];
  private matrix = new Float32Array(16);

  constructor(
    readonly id: string,
    private readonly atlas: BadgeAtlas,
    /** képkockánként: a kirajzolandó képek, alulról felfelé (a késői fedi a korábbit) */
    private readonly collect: (out: Sprite[]) => void,
  ) {}

  onAdd(_map: MLMap, gl: WebGL2RenderingContext): void {
    const program = gl.createProgram();
    if (!program) throw new Error("program");
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");

    const vao = gl.createVertexArray();
    const corners = gl.createBuffer();
    const instances = gl.createBuffer();
    const texture = gl.createTexture();
    if (!vao || !corners || !instances || !texture) throw new Error("gl erőforrás");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS * 4;
    const attr = (loc: number, size: number, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 3, 0);
    attr(2, 4, 3);
    attr(3, 4, 7);
    attr(4, 1, 11);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS_SIZE, ATLAS_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.all());
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.st = {
      program,
      vao,
      instances,
      corners,
      texture,
      uMatrix: gl.getUniformLocation(program, "u_matrix"),
      uViewport: gl.getUniformLocation(program, "u_viewport"),
      uScale: gl.getUniformLocation(program, "u_scale"),
      uTex: gl.getUniformLocation(program, "u_tex"),
      capacity: this.data.length / FLOATS,
    };
  }

  onRemove(_map: MLMap, gl: WebGL2RenderingContext): void {
    const st = this.st;
    if (!st) return;
    gl.deleteProgram(st.program);
    gl.deleteVertexArray(st.vao);
    gl.deleteBuffer(st.instances);
    gl.deleteBuffer(st.corners);
    gl.deleteTexture(st.texture);
    this.st = null;
  }

  render(glAny: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const st = this.st;
    if (!st || !(glAny instanceof WebGL2RenderingContext)) return;
    const gl = glAny;
    const sprites = this.sprites;
    sprites.length = 0;
    this.collect(sprites);
    if (sprites.length === 0) return;

    // Egyetlen középpontra vonatkoztatva (float64-ben számolva): a float32 Mercator 0..1
    // tartományban ~2 m-es lépcsőket adna, a csempe közelről remegne.
    const cx = sprites[0].mx;
    const cy = sprites[0].my;
    const m = options.defaultProjectionData.mainMatrix;
    for (let i = 0; i < 12; i++) this.matrix[i] = m[i];
    for (let r = 0; r < 4; r++) this.matrix[12 + r] = m[r] * cx + m[4 + r] * cy + m[12 + r];

    if (sprites.length > st.capacity) {
      st.capacity = Math.max(sprites.length, st.capacity * 2);
      this.data = new Float32Array(st.capacity * FLOATS);
      gl.bindBuffer(gl.ARRAY_BUFFER, st.instances);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    }
    const d = this.data;
    let o = 0;
    for (const s of sprites) {
      const e = s.entry;
      d[o] = s.mx - cx;
      d[o + 1] = s.my - cy;
      d[o + 2] = s.mz;
      d[o + 3] = e.u0;
      d[o + 4] = e.v0;
      d[o + 5] = e.u1;
      d[o + 6] = e.v1;
      d[o + 7] = e.x;
      d[o + 8] = e.y;
      d[o + 9] = e.w;
      d[o + 10] = e.h;
      d[o + 11] = s.alpha;
      o += FLOATS;
    }

    gl.useProgram(st.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.texture);
    const dirty = this.atlas.takeDirty();
    if (dirty) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, dirty.x, dirty.y, gl.RGBA, gl.UNSIGNED_BYTE, dirty.data);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, st.instances);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, o);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.uniformMatrix4fv(st.uMatrix, false, this.matrix);
    gl.uniform2f(st.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(st.uScale, this.atlas.scale);
    gl.uniform1i(st.uTex, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(st.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sprites.length);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
