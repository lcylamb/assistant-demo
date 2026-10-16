import type { AskResult } from '../../src/modules/assistant/ask.types.js';

/**
 * 把 SSE 响应体切成帧。
 *
 * ⚠️ 这份解析**必须**和服务端写帧的方式对齐（`assistant.controller.ts` 里的 `writeEvent`）。
 * 现在一共四处要读同一套规则：服务端写、这个测试辅助读、`public/index.html` 读、
 * `scripts/ask-stream-probe.mjs` 读。任何一处偷偷改了分帧规则，另外三处都会读错，
 * 而症状是「页面上少几个字」这种很难定位的样子。
 *
 * 所以测试侧只留这一份，谁需要谁 import —— 三份拷贝里改一份，
 * 是这类代码最容易出的错。
 */
export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

export function parseSse(body: string): SseFrame[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      let event = 'message';
      const dataLines: string[] = [];

      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }

      return {
        event,
        data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
      };
    });
}

/**
 * `done` 帧的 data 就是 `AskResult` —— 这是服务端的契约。
 * 解析出来是 `Record<string, unknown>`，这里做一次显式转换，
 * 顺带把「done 帧里装的必须是 AskResult」这件事在测试里写明。
 */
export function asResult(frame: SseFrame | undefined): AskResult {
  return frame?.data as unknown as AskResult;
}
