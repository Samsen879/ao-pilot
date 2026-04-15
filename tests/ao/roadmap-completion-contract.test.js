import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const PROJECT_ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

describe('AO roadmap completion contract', () => {
  it('marks unresolved-gap analysis as historical once phase 1-6 are complete', () => {
    const roadmapText = read('docs/setup/AO_COMPLETE_STATE_ROADMAP.md');

    expect(roadmapText).toContain('| 6 | 历史债务清理和 soak | ✅ 已完成 |');
    expect(roadmapText).toContain('## 3. 历史上还缺什么');
    expect(roadmapText).toContain('以下差距分析保留为 phase 1-6 启动前的历史判断');
    expect(roadmapText).not.toContain('## 3. 现在还缺什么');
    expect(roadmapText).not.toContain('AO 当前还缺的');
  });
});
