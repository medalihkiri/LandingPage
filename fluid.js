
class FluidAnimation {
    constructor(canvas) {
        this.canvas = canvas;
        this.config = {
            SIM_RESOLUTION: 96,
            DYE_RESOLUTION: 1024,
            CAPTURE_RESOLUTION: 512,
            DENSITY_DISSIPATION: 1.2,
            VELOCITY_DISSIPATION: 0.8,
            PRESSURE: 0.02,
            PRESSURE_ITERATIONS: 14,
            CURL: 0.2,
            SPLAT_RADIUS: 0.4,
            SPLAT_FORCE: 6000,
            SHADING: true,
            COLOR_UPDATE_SPEED: 10,
            BACK_COLOR: { r: 0.02, g: 0.02, b: 0.02 },
            TRANSPARENT: true
        };

        this.pointers = [{
            id: -1,
            texcoordX: 0,
            texcoordY: 0,
            prevTexcoordX: 0,
            prevTexcoordY: 0,
            deltaX: 0,
            deltaY: 0,
            down: false,
            moved: false,
            color: { r: 1, g: 0, b: 0.2 } // Initial red
        }];

        this.initWebGL();
        this.initFramebuffers();
        this.updateKeywords();
        
        this.lastUpdateTime = Date.now();
        this.colorUpdateTimer = 0;
        
        this.autoSplatInterval = null;
        
        window.addEventListener('mousedown', e => {
            if (this.isPaused()) return;
            this.handleMouseDown(e);
        });
        window.addEventListener('mousemove', e => {
            if (this.isPaused()) return;
            this.handleMouseMove(e);
        });
        window.addEventListener('touchstart', e => {
            if (this.isPaused()) return;
            this.handleTouchStart(e);
        });
        window.addEventListener('touchmove', e => {
            if (this.isPaused()) return;
            this.handleTouchMove(e);
        }, { passive: true });
        window.addEventListener('touchend', e => {
            this.handleTouchEnd(e);
        });
        window.addEventListener('resize', () => this.resizeCanvas());

        this.resizeCanvas();
        this.animate();
    }

    initWebGL() {
        const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
        const gl = this.canvas.getContext('webgl2', params) || this.canvas.getContext('webgl', params) || this.canvas.getContext('experimental-webgl', params);
        this.gl = gl;

        const isWebGL2 = !!this.canvas.getContext('webgl2', params);
        let halfFloat;
        let supportLinearFiltering;

        if (isWebGL2) {
            gl.getExtension('EXT_color_buffer_float');
            supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
        } else {
            halfFloat = gl.getExtension('OES_texture_half_float');
            supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
        }

        gl.clearColor(0.0, 0.0, 0.0, 1.0);

        const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : (halfFloat ? halfFloat.HALF_FLOAT_OES : 0);
        let formatRGBA, formatRG, formatR;

        if (isWebGL2) {
            formatRGBA = this.getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
            formatRG = this.getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
            formatR = this.getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
        } else {
            formatRGBA = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            formatRG = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            formatR = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        }

        this.ext = { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering };
        
        this.initShaders();
    }

    getSupportedFormat(gl, internalFormat, format, type) {
        if (!this.supportRenderTextureFormat(gl, internalFormat, format, type)) {
            switch (internalFormat) {
                case gl.R16F: return this.getSupportedFormat(gl, gl.RG16F, gl.RG, type);
                case gl.RG16F: return this.getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
                default: return null;
            }
        }
        return { internalFormat, format };
    }

    supportRenderTextureFormat(gl, internalFormat, format, type) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        return status === gl.FRAMEBUFFER_COMPLETE;
    }

    initShaders() {
        const gl = this.gl;
        const baseVertexShader = this.compileShader(gl.VERTEX_SHADER, `
            precision highp float;
            attribute vec2 aPosition;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform vec2 texelSize;
            void main () {
                vUv = aPosition * 0.5 + 0.5;
                vL = vUv - vec2(texelSize.x, 0.0);
                vR = vUv + vec2(texelSize.x, 0.0);
                vT = vUv + vec2(0.0, texelSize.y);
                vB = vUv - vec2(0.0, texelSize.y);
                gl_Position = vec4(aPosition, 0.0, 1.0);
            }
        `);

        const copyShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            uniform sampler2D uTexture;
            void main () { gl_FragColor = texture2D(uTexture, vUv); }
        `);

        const clearShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            uniform sampler2D uTexture;
            uniform float value;
            void main () { gl_FragColor = value * texture2D(uTexture, vUv); }
        `);

        this.displayShaderSource = `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uTexture;
            uniform vec2 texelSize;
            void main () {
                vec3 c = texture2D(uTexture, vUv).rgb;
                #ifdef SHADING
                    vec3 lc = texture2D(uTexture, vL).rgb;
                    vec3 rc = texture2D(uTexture, vR).rgb;
                    vec3 tc = texture2D(uTexture, vT).rgb;
                    vec3 bc = texture2D(uTexture, vB).rgb;
                    float dx = length(rc) - length(lc);
                    float dy = length(tc) - length(bc);
                    vec3 n = normalize(vec3(dx, dy, length(texelSize)));
                    vec3 l = vec3(0.0, 0.0, 1.0);
                    float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
                    c *= diffuse;
                #endif
                float a = max(c.r, max(c.g, c.b));
                gl_FragColor = vec4(c, a);
            }
        `;

        const splatShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            uniform sampler2D uTarget;
            uniform float aspectRatio;
            uniform vec3 color;
            uniform vec2 point;
            uniform float radius;
            void main () {
                vec2 p = vUv - point.xy;
                p.x *= aspectRatio;
                vec3 splat = exp(-dot(p, p) / radius) * color;
                vec3 base = texture2D(uTarget, vUv).xyz;
                gl_FragColor = vec4(base + splat, 1.0);
            }
        `);

        const advectionShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            uniform sampler2D uVelocity;
            uniform sampler2D uSource;
            uniform vec2 texelSize;
            uniform vec2 dyeTexelSize;
            uniform float dt;
            uniform float dissipation;
            vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
                vec2 st = uv / tsize - 0.5;
                vec2 iuv = floor(st);
                vec2 fuv = fract(st);
                vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
                vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
                vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
                vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
                return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
            }
            void main () {
                #ifdef MANUAL_FILTERING
                    vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
                    vec4 result = bilerp(uSource, coord, dyeTexelSize);
                #else
                    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
                    vec4 result = texture2D(uSource, coord);
                #endif
                float decay = 1.0 + dissipation * dt;
                gl_FragColor = result / decay;
            }
        `, this.ext.supportLinearFiltering ? undefined : ['MANUAL_FILTERING']);

        const divergenceShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            varying highp vec2 vL;
            varying highp vec2 vR;
            varying highp vec2 vT;
            varying highp vec2 vB;
            uniform sampler2D uVelocity;
            void main () {
                float L = texture2D(uVelocity, vL).x;
                float R = texture2D(uVelocity, vR).x;
                float T = texture2D(uVelocity, vT).y;
                float B = texture2D(uVelocity, vB).y;
                vec2 C = texture2D(uVelocity, vUv).xy;
                if (vL.x < 0.0) { L = -C.x; }
                if (vR.x > 1.0) { R = -C.x; }
                if (vT.y > 1.0) { T = -C.y; }
                if (vB.y < 0.0) { B = -C.y; }
                float div = 0.5 * (R - L + T - B);
                gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
            }
        `);

        const curlShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            varying highp vec2 vL;
            varying highp vec2 vR;
            varying highp vec2 vT;
            varying highp vec2 vB;
            uniform sampler2D uVelocity;
            void main () {
                float L = texture2D(uVelocity, vL).y;
                float R = texture2D(uVelocity, vR).y;
                float T = texture2D(uVelocity, vT).x;
                float B = texture2D(uVelocity, vB).x;
                float vorticity = R - L - T + B;
                gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
            }
        `);

        const vorticityShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uVelocity;
            uniform sampler2D uCurl;
            uniform float curl;
            uniform float dt;
            void main () {
                float L = texture2D(uCurl, vL).x;
                float R = texture2D(uCurl, vR).x;
                float T = texture2D(uCurl, vT).x;
                float B = texture2D(uCurl, vB).x;
                float C = texture2D(uCurl, vUv).x;
                vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
                force /= length(force) + 0.0001;
                force *= curl * C;
                force.y *= -1.0;
                vec2 velocity = texture2D(uVelocity, vUv).xy;
                velocity += force * dt;
                velocity = min(max(velocity, -1000.0), 1000.0);
                gl_FragColor = vec4(velocity, 0.0, 1.0);
            }
        `);

        const pressureShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            varying highp vec2 vL;
            varying highp vec2 vR;
            varying highp vec2 vT;
            varying highp vec2 vB;
            uniform sampler2D uPressure;
            uniform sampler2D uDivergence;
            void main () {
                float L = texture2D(uPressure, vL).x;
                float R = texture2D(uPressure, vR).x;
                float T = texture2D(uPressure, vT).x;
                float B = texture2D(uPressure, vB).x;
                float divergence = texture2D(uDivergence, vUv).x;
                float pressure = (L + R + B + T - divergence) * 0.25;
                gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
            }
        `);

        const gradienSubtractShader = this.compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            varying highp vec2 vL;
            varying highp vec2 vR;
            varying highp vec2 vT;
            varying highp vec2 vB;
            uniform sampler2D uPressure;
            uniform sampler2D uVelocity;
            void main () {
                float L = texture2D(uPressure, vL).x;
                float R = texture2D(uPressure, vR).x;
                float T = texture2D(uPressure, vT).x;
                float B = texture2D(uPressure, vB).x;
                vec2 velocity = texture2D(uVelocity, vUv).xy;
                velocity.xy -= vec2(R - L, T - B);
                gl_FragColor = vec4(velocity, 0.0, 1.0);
            }
        `);

        this.copyProgram = new Program(gl, baseVertexShader, copyShader);
        this.clearProgram = new Program(gl, baseVertexShader, clearShader);
        this.splatProgram = new Program(gl, baseVertexShader, splatShader);
        this.advectionProgram = new Program(gl, baseVertexShader, advectionShader);
        this.divergenceProgram = new Program(gl, baseVertexShader, divergenceShader);
        this.curlProgram = new Program(gl, baseVertexShader, curlShader);
        this.vorticityProgram = new Program(gl, baseVertexShader, vorticityShader);
        this.pressureProgram = new Program(gl, baseVertexShader, pressureShader);
        this.gradienSubtractProgram = new Program(gl, baseVertexShader, gradienSubtractShader);
        this.displayMaterial = new Material(gl, baseVertexShader, this.displayShaderSource);

        this.blit = (() => {
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(0);

            return (target, clear = false) => {
                if (target == null) {
                    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                } else {
                    gl.viewport(0, 0, target.width, target.height);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
                }
                if (clear) {
                    gl.clearColor(0, 0, 0, 1);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                }
                gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
            };
        })();
    }

    compileShader(type, source, keywords) {
        const gl = this.gl;
        if (keywords) {
            let keywordsString = '';
            keywords.forEach(keyword => { keywordsString += '#define ' + keyword + '\n'; });
            source = keywordsString + source;
        }
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
        return shader;
    }

    initFramebuffers() {
        const gl = this.gl;
        const simRes = this.getResolution(this.config.SIM_RESOLUTION);
        const dyeRes = this.getResolution(this.config.DYE_RESOLUTION);
        const texType = this.ext.halfFloatTexType;
        const rgba = this.ext.formatRGBA;
        const rg = this.ext.formatRG;
        const r = this.ext.formatR;
        const filtering = this.ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

        gl.disable(gl.BLEND);

        if (!this.dye) this.dye = this.createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
        else this.dye = this.resizeDoubleFBO(this.dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

        if (!this.velocity) this.velocity = this.createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
        else this.velocity = this.resizeDoubleFBO(this.velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

        this.divergence = this.createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
        this.curl = this.createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
        this.pressure = this.createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    }

    createFBO(w, h, internalFormat, format, type, param) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);

        return { texture, fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h, attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; } };
    }

    createDoubleFBO(w, h, internalFormat, format, type, param) {
        let fbo1 = this.createFBO(w, h, internalFormat, format, type, param);
        let fbo2 = this.createFBO(w, h, internalFormat, format, type, param);
        return { width: w, height: h, texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY, get read() { return fbo1; }, set read(v) { fbo1 = v; }, get write() { return fbo2; }, set write(v) { fbo2 = v; }, swap() { let temp = fbo1; fbo1 = fbo2; fbo2 = temp; } };
    }

    resizeFBO(target, w, h, internalFormat, format, type, param) {
        const newFBO = this.createFBO(w, h, internalFormat, format, type, param);
        this.copyProgram.bind();
        this.gl.uniform1i(this.copyProgram.uniforms.uTexture, target.attach(0));
        this.blit(newFBO);
        return newFBO;
    }

    resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
        if (target.width === w && target.height === h) return target;
        target.read = this.resizeFBO(target.read, w, h, internalFormat, format, type, param);
        target.write = this.createFBO(w, h, internalFormat, format, type, param);
        target.width = w; target.height = h; target.texelSizeX = 1 / w; target.texelSizeY = 1 / h;
        return target;
    }

    updateKeywords() {
        const displayKeywords = [];
        if (this.config.SHADING) displayKeywords.push('SHADING');
        this.displayMaterial.setKeywords(displayKeywords);
    }

    getResolution(resolution) {
        const gl = this.gl;
        let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
        if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;
        const min = Math.round(resolution);
        const max = Math.round(resolution * aspectRatio);
        if (gl.drawingBufferWidth > gl.drawingBufferHeight) return { width: max, height: min };
        return { width: min, height: max };
    }

    resizeCanvas() {
        const width = this.scaleByPixelRatio(this.canvas.clientWidth);
        const height = this.scaleByPixelRatio(this.canvas.clientHeight);
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.initFramebuffers();
        }
    }

    scaleByPixelRatio(input) {
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        return Math.floor(input * pixelRatio);
    }

    handleMouseDown(e) {
        const posX = this.scaleByPixelRatio(e.clientX);
        const posY = this.scaleByPixelRatio(e.clientY);
        this.updatePointerDownData(this.pointers[0], -1, posX, posY);
        this.clickSplat(this.pointers[0]);
    }

    handleMouseMove(e) {
        const posX = this.scaleByPixelRatio(e.clientX);
        const posY = this.scaleByPixelRatio(e.clientY);
        this.updatePointerMoveData(this.pointers[0], posX, posY);
    }

    handleTouchStart(e) {
        for (let i = 0; i < e.targetTouches.length; i++) {
            const posX = this.scaleByPixelRatio(e.targetTouches[i].clientX);
            const posY = this.scaleByPixelRatio(e.targetTouches[i].clientY);
            this.updatePointerDownData(this.pointers[0], e.targetTouches[i].identifier, posX, posY);
        }
    }

    handleTouchMove(e) {
        for (let i = 0; i < e.targetTouches.length; i++) {
            const posX = this.scaleByPixelRatio(e.targetTouches[i].clientX);
            const posY = this.scaleByPixelRatio(e.targetTouches[i].clientY);
            this.updatePointerMoveData(this.pointers[0], posX, posY);
        }
    }

    handleTouchEnd(e) {
        this.pointers[0].down = false;
    }

    updatePointerDownData(pointer, id, posX, posY) {
        pointer.id = id;
        pointer.down = true;
        pointer.moved = false;
        pointer.texcoordX = posX / this.canvas.width;
        pointer.texcoordY = 1.0 - posY / this.canvas.height;
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
        pointer.deltaX = 0;
        pointer.deltaY = 0;
        pointer.color = this.generateColor();
    }

    updatePointerMoveData(pointer, posX, posY) {
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
        pointer.texcoordX = posX / this.canvas.width;
        pointer.texcoordY = 1.0 - posY / this.canvas.height;
        pointer.deltaX = this.correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
        pointer.deltaY = this.correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
        pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
    }

    correctDeltaX(delta) { let aspectRatio = this.canvas.width / this.canvas.height; if (aspectRatio < 1) delta *= aspectRatio; return delta; }
    correctDeltaY(delta) { let aspectRatio = this.canvas.width / this.canvas.height; if (aspectRatio > 1) delta /= aspectRatio; return delta; }

    generateColor() {
        // From Portfolio: Pure red
        return { r: 1.0, g: 0.0, b: 0.0 };
    }

    clickSplat(pointer) {
        const color = this.generateColor();
        color.r *= 10; color.g *= 10; color.b *= 10;
        const dx = 10 * (Math.random() - 0.5);
        const dy = 30 * (Math.random() - 0.5);
        this.splat(pointer.texcoordX, pointer.texcoordY, dx, dy, color);
    }

    splat(x, y, dx, dy, color) {
        const gl = this.gl;
        this.splatProgram.bind();
        gl.uniform1i(this.splatProgram.uniforms.uTarget, this.velocity.read.attach(0));
        gl.uniform1f(this.splatProgram.uniforms.aspectRatio, this.canvas.width / this.canvas.height);
        gl.uniform2f(this.splatProgram.uniforms.point, x, y);
        gl.uniform3f(this.splatProgram.uniforms.color, dx, dy, 0.0);
        gl.uniform1f(this.splatProgram.uniforms.radius, this.correctRadius(this.config.SPLAT_RADIUS / 100.0));
        this.blit(this.velocity.write);
        this.velocity.swap();

        gl.uniform1i(this.splatProgram.uniforms.uTarget, this.dye.read.attach(0));
        gl.uniform3f(this.splatProgram.uniforms.color, color.r, color.g, color.b);
        this.blit(this.dye.write);
        this.dye.swap();
    }

    correctRadius(radius) { let aspectRatio = this.canvas.width / this.canvas.height; if (aspectRatio > 1) radius *= aspectRatio; return radius; }

    isPaused() {
        const tarifPanel = document.getElementById('tarif-panel');
        return tarifPanel && tarifPanel.classList.contains('active');
    }

    animate() {
        const dt = this.calcDeltaTime();
        this.updateColors(dt);
        this.applyInputs();
        this.step(dt);
        this.render(null);
        requestAnimationFrame(() => this.animate());
    }

    calcDeltaTime() {
        const now = Date.now();
        let dt = (now - this.lastUpdateTime) / 1000;
        dt = Math.min(dt, 0.016666);
        this.lastUpdateTime = now;
        return dt;
    }

    updateColors(dt) {
        this.colorUpdateTimer += dt * this.config.COLOR_UPDATE_SPEED;
        if (this.colorUpdateTimer >= 1) {
            this.colorUpdateTimer = 0;
            this.pointers.forEach(p => { p.color = this.generateColor(); });
        }
    }

    applyInputs() {
        this.pointers.forEach(p => {
            if (p.moved) {
                p.moved = false;
                this.splat(p.texcoordX, p.texcoordY, p.deltaX * this.config.SPLAT_FORCE, p.deltaY * this.config.SPLAT_FORCE, p.color);
            }
        });
    }

    step(dt) {
        const gl = this.gl;
        gl.disable(gl.BLEND);

        this.curlProgram.bind();
        gl.uniform2f(this.curlProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
        gl.uniform1i(this.curlProgram.uniforms.uVelocity, this.velocity.read.attach(0));
        this.blit(this.curl);

        this.vorticityProgram.bind();
        gl.uniform2f(this.vorticityProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
        gl.uniform1i(this.vorticityProgram.uniforms.uVelocity, this.velocity.read.attach(0));
        gl.uniform1i(this.vorticityProgram.uniforms.uCurl, this.curl.attach(1));
        gl.uniform1f(this.vorticityProgram.uniforms.curl, this.config.CURL);
        gl.uniform1f(this.vorticityProgram.uniforms.dt, dt);
        this.blit(this.velocity.write);
        this.velocity.swap();

        this.divergenceProgram.bind();
        gl.uniform2f(this.divergenceProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
        gl.uniform1i(this.divergenceProgram.uniforms.uVelocity, this.velocity.read.attach(0));
        this.blit(this.divergence);

        this.clearProgram.bind();
        gl.uniform1i(this.clearProgram.uniforms.uTexture, this.pressure.read.attach(0));
        gl.uniform1f(this.clearProgram.uniforms.value, this.config.PRESSURE);
        this.blit(this.pressure.write);
        this.pressure.swap();

        this.pressureProgram.bind();
        gl.uniform2f(this.pressureProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
        gl.uniform1i(this.pressureProgram.uniforms.uDivergence, this.divergence.attach(0));
        for (let i = 0; i < this.config.PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(this.pressureProgram.uniforms.uPressure, this.pressure.read.attach(1));
            this.blit(this.pressure.write);
            this.pressure.swap();
        }

        this.gradienSubtractProgram.bind();
        gl.uniform2f(this.gradienSubtractProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
        gl.uniform1i(this.gradienSubtractProgram.uniforms.uPressure, this.pressure.read.attach(0));
        gl.uniform1i(this.gradienSubtractProgram.uniforms.uVelocity, this.velocity.read.attach(1));
        this.blit(this.velocity.write);
        this.velocity.swap();

        this.advectionProgram.bind();
        gl.uniform2f(this.advectionProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
        if (!this.ext.supportLinearFiltering) gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
        const velocityId = this.velocity.read.attach(0);
        gl.uniform1i(this.advectionProgram.uniforms.uVelocity, velocityId);
        gl.uniform1i(this.advectionProgram.uniforms.uSource, velocityId);
        gl.uniform1f(this.advectionProgram.uniforms.dt, dt);
        gl.uniform1f(this.advectionProgram.uniforms.dissipation, this.config.VELOCITY_DISSIPATION);
        this.blit(this.velocity.write);
        this.velocity.swap();

        if (!this.ext.supportLinearFiltering) gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, this.dye.texelSizeX, this.dye.texelSizeY);
        gl.uniform1i(this.advectionProgram.uniforms.uVelocity, this.velocity.read.attach(0));
        gl.uniform1i(this.advectionProgram.uniforms.uSource, this.dye.read.attach(1));
        gl.uniform1f(this.advectionProgram.uniforms.dissipation, this.config.DENSITY_DISSIPATION);
        this.blit(this.dye.write);
        this.dye.swap();
    }

    render(target) {
        const gl = this.gl;
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
        const width = target == null ? gl.drawingBufferWidth : target.width;
        const height = target == null ? gl.drawingBufferHeight : target.height;
        this.displayMaterial.bind();
        if (this.config.SHADING) gl.uniform2f(this.displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
        gl.uniform1i(this.displayMaterial.uniforms.uTexture, this.dye.read.attach(0));
        this.blit(target);
    }

    // --- Automatic Swirls Logic ---
    startAutoSwirls() {
        if (this.autoSplatInterval) return;
        this.autoSplatInterval = setInterval(() => {
            const x = Math.random();
            const y = Math.random();
            const dx = (Math.random() - 0.5) * 3500;
            const dy = (Math.random() - 0.5) * 3500;
            const color = this.generateColor();
            this.splat(x, y, dx, dy, color);
        }, 500);
    }

    stopAutoSwirls() {
        if (this.autoSplatInterval) {
            clearInterval(this.autoSplatInterval);
            this.autoSplatInterval = null;
        }
    }
}

class Material {
    constructor(gl, vertexShader, fragmentShaderSource) {
        this.gl = gl;
        this.vertexShader = vertexShader;
        this.fragmentShaderSource = fragmentShaderSource;
        this.programs = {};
        this.activeProgram = null;
        this.uniforms = {};
    }
    setKeywords(keywords) {
        const gl = this.gl;
        let hash = 0;
        for (let i = 0; i < keywords.length; i++) {
            let s = keywords[i];
            for (let j = 0; j < s.length; j++) hash = (hash << 5) - hash + s.charCodeAt(j) | 0;
        }
        let program = this.programs[hash];
        if (program == null) {
            let source = this.fragmentShaderSource;
            let keywordsString = '';
            keywords.forEach(keyword => { keywordsString += '#define ' + keyword + '\n'; });
            source = keywordsString + source;
            const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
            gl.shaderSource(fragmentShader, source);
            gl.compileShader(fragmentShader);
            program = gl.createProgram();
            gl.attachShader(program, this.vertexShader);
            gl.attachShader(program, fragmentShader);
            gl.linkProgram(program);
            this.programs[hash] = program;
        }
        if (program === this.activeProgram) return;
        this.activeProgram = program;
        this.uniforms = {};
        const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < uniformCount; i++) {
            const name = gl.getActiveUniform(program, i).name;
            this.uniforms[name] = gl.getUniformLocation(program, name);
        }
    }
    bind() { this.gl.useProgram(this.activeProgram); }
}

class Program {
    constructor(gl, vertexShader, fragmentShader) {
        this.gl = gl;
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);
        this.uniforms = {};
        const uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < uniformCount; i++) {
            const name = gl.getActiveUniform(this.program, i).name;
            this.uniforms[name] = gl.getUniformLocation(this.program, name);
        }
    }
    bind() { this.gl.useProgram(this.program); }
}
