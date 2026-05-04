import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
} from '@angular/core';

@Component({
  selector: 'vfx-smoke-and-embers',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="vfx-wrapper">
      <div class="glow-overlay"></div>
      <canvas #vfxCanvas></canvas>
      <div class="vignette"></div>
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      display: block;
      z-index: 0;
      pointer-events: none;
      overflow: hidden;
    }

    .vfx-wrapper {
      position: relative;
      width: 100%;
      height: 100%;
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    .glow-overlay {
      position: absolute;
      bottom: -10%;
      left: 50%;
      transform: translateX(-50%);
      width: 150%;
      height: 40%;
      background: radial-gradient(circle, rgba(255, 80, 0, 0.12) 0%, rgba(255, 30, 0, 0.04) 50%, transparent 80%);
      pointer-events: none;
      filter: blur(25px);
    }

    .vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, transparent 30%, rgba(0, 0, 0, 0.5) 100%);
      pointer-events: none;
    }
  `,
})
export class VfxSmokeAndEmbersComponent implements AfterViewInit, OnDestroy {
  @ViewChild('vfxCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private ctx!: CanvasRenderingContext2D;
  private smokeTexture!: HTMLCanvasElement;
  private animationId?: number;
  private particles: Particle[] = [];
  private smokeParticles: SmokeParticle[] = [];
  private lastTime = 0;
  private resizeObserver?: ResizeObserver;

  constructor(private ngZone: NgZone) {}

  ngAfterViewInit(): void {
    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;
    this.smokeTexture = this.createSmokeTexture();
    this.handleResize();
    this.resizeObserver = new ResizeObserver(() => {
      this.ngZone.runOutsideAngular(() => this.handleResize());
    });
    this.resizeObserver.observe(this.canvasRef.nativeElement);
    this.seedParticles();
    this.ngZone.runOutsideAngular(() => {
      this.initAnimation();
    });
  }

  ngOnDestroy(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.resizeObserver?.disconnect();
  }

  private handleResize(): void {
    const canvas = this.canvasRef.nativeElement;
    const w = canvas.clientWidth || canvas.offsetWidth || 200;
    const h = canvas.clientHeight || canvas.offsetHeight || 500;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  private seedParticles(): void {
    for (let i = 0; i < 20; i += 1) {
      const particle = new Particle();
      particle.y = Math.random() * 1.1 - 0.05;
      particle.life = Math.random() * particle.maxLife;
      this.particles.push(particle);
    }
    for (let i = 0; i < 15; i += 1) {
      const smokeParticle = new SmokeParticle();
      smokeParticle.y = Math.random() * 1.2 - 0.1;
      smokeParticle.life = Math.random() * smokeParticle.maxLife;
      this.smokeParticles.push(smokeParticle);
    }
  }

  private createSmokeTexture(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 60; i += 1) {
      const x = 64 + (Math.random() - 0.5) * 80;
      const y = 64 + (Math.random() - 0.5) * 80;
      const radius = 5 + Math.random() * 25;
      const alpha = 0.02 + Math.random() * 0.08;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 15; i += 1) {
      const x = 64 + (Math.random() - 0.5) * 90;
      const y = 64 + (Math.random() - 0.5) * 90;
      const radius = 8 + Math.random() * 20;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    return canvas;
  }

  private initAnimation(): void {
    const animate = (time: number) => {
      if (!this.lastTime) this.lastTime = time;
      const deltaTime = time - this.lastTime;
      this.lastTime = time;
      const dt = Math.min(deltaTime, 100) / 16.67;
      this.update(dt);
      this.draw(time);
      this.animationId = requestAnimationFrame(animate);
    };
    this.animationId = requestAnimationFrame(animate);
  }

  private update(dt: number): void {
    if (Math.random() < 0.018 * dt) this.particles.push(new Particle());
    if (Math.random() < 0.015 * dt) this.smokeParticles.push(new SmokeParticle());
    this.particles = this.particles.filter((particle) => particle.update(dt));
    this.smokeParticles = this.smokeParticles.filter((particle) => particle.update(dt));
  }

  private draw(time: number): void {
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.width;
    const height = canvas.height;
    if (width === 0 || height === 0) return;
    this.ctx.clearRect(0, 0, width, height);
    const pulse = Math.sin(time / 1000) * 0.03 + 0.1;
    const gradient = this.ctx.createRadialGradient(width / 2, height, 0, width / 2, height, height);
    gradient.addColorStop(0, `rgba(255, 80, 0, ${pulse})`);
    gradient.addColorStop(0.6, 'transparent');
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, width, height);
    this.smokeParticles.forEach((particle) =>
      particle.draw(this.ctx, this.smokeTexture, width, height),
    );
    this.particles.forEach((particle) => particle.draw(this.ctx, width, height, time));
  }
}

class Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  jitter: number;
  size: number;
  life: number;
  maxLife: number;
  color: string;
  pulseOffset: number;

  constructor() {
    this.x = 0.5 + (Math.random() - 0.5) * 0.35;
    this.y = 1.05;
    this.vx = (Math.random() - 0.5) * 0.0006;
    this.vy = -(Math.random() * 0.0006 + 0.0003);
    this.jitter = 0.00004 + Math.random() * 0.00008;
    this.size = Math.random() * 0.002 + 0.001;
    this.maxLife = 1200 + Math.random() * 800;
    this.life = this.maxLife;
    this.pulseOffset = Math.random() * Math.PI * 2;
    const g = Math.floor(Math.random() * 50 + 170);
    this.color = `255, ${g}, ${Math.floor(Math.random() * 30)}`;
  }

  update(dt: number): boolean {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx += (Math.random() - 0.5) * this.jitter * dt;
    this.life -= dt;
    return this.life > 0 && this.y > -0.15;
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    let alpha = 0.7;
    if (this.y < 0.6) alpha = Math.max(0, 0.7 * ((this.y - 0.2) / 0.4));
    if (this.y > 0.95) alpha *= Math.max(0, (1.05 - this.y) / 0.1);
    const pulse = Math.sin(time / 750 + this.pulseOffset) * 0.2 + 0.8;
    const finalAlpha = alpha * pulse;
    const px = this.x * width;
    const py = this.y * height;
    const baseSize = this.size * width * pulse;
    const particleSize = Math.min(baseSize, 2.5);

    ctx.beginPath();
    ctx.arc(px, py, particleSize, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${this.color}, ${finalAlpha})`;
    ctx.shadowBlur = particleSize * 2.5;
    ctx.shadowColor = `rgba(${this.color}, ${finalAlpha})`;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

class SmokeParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  scaleX: number;
  scaleY: number;
  size: number;
  life: number;
  maxLife: number;

  constructor() {
    this.x = 0.5 + (Math.random() - 0.5) * 0.25;
    this.y = 1.08;
    this.vx = (Math.random() - 0.5) * 0.0003;
    this.vy = -(Math.random() * 0.0002 + 0.0001);
    this.rotation = Math.random() * Math.PI * 2;
    this.rotationSpeed = (Math.random() - 0.5) * 0.004;
    this.scaleX = 0.8 + Math.random() * 0.6;
    this.scaleY = 0.8 + Math.random() * 0.6;
    this.size = 0.25 + Math.random() * 0.35;
    this.maxLife = 10000 + Math.random() * 5000;
    this.life = this.maxLife;
  }

  update(dt: number): boolean {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rotation += this.rotationSpeed * dt;
    this.size += 0.00006 * dt;
    this.life -= dt;
    return this.life > 0 && this.y > -0.35;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    texture: HTMLCanvasElement,
    width: number,
    height: number,
  ): void {
    let alpha = 0.1;
    if (this.y > 0.8) alpha = Math.max(0, 0.1 * ((1.0 - this.y) / 0.2));
    else if (this.y < 0.4) alpha = Math.max(0, 0.1 * (this.y / 0.4));
    const lifeRatio = this.life / this.maxLife;
    const finalOpacity = alpha * (lifeRatio < 0.15 ? lifeRatio / 0.15 : 1);
    ctx.save();
    ctx.translate(this.x * width, this.y * height);
    ctx.rotate(this.rotation);
    ctx.scale(this.scaleX, this.scaleY);
    ctx.globalAlpha = finalOpacity;
    ctx.globalCompositeOperation = 'screen';
    const particleSize = this.size * width;
    ctx.drawImage(texture, -particleSize / 2, -particleSize / 2, particleSize, particleSize);
    ctx.restore();
  }
}
