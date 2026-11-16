declare module 'mind-ar/dist/mindar-image.prod.js' {
  export class Controller {
    constructor(opts: {
      inputWidth: number;
      inputHeight: number;
      onUpdate?: (data: { type: string; targetIndex?: number; worldMatrix?: number[] | null }) => void;
      filterMinCF?: number | null;
      filterBeta?: number | null;
      warmupTolerance?: number | null;
      missTolerance?: number | null;
      maxTrack?: number;
    });
    inputWidth: number;
    inputHeight: number;
    addImageTargets(url: string): Promise<{ dimensions: [number, number][] }>;
    dummyRun(video: HTMLVideoElement): Promise<void>;
    processVideo(video: HTMLVideoElement): void;
    stopProcessVideo(): void;
    getProjectionMatrix(): number[];
  }
  export class Compiler {
    compileImageTargets(images: HTMLImageElement[], progress: (p: number) => void): Promise<any[]>;
    exportData(): ArrayBuffer;
  }
}
