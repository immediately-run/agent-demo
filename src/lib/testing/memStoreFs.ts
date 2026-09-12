// The shared in-memory StoreFs for the conversation tests (R3-594 / R6): the store tests
// carried one copy and the scope tests a second, so the stage-selection test — which needs
// a real store over an in-memory fs — would have been the third. Absolute POSIX paths;
// directories are tracked so `readdir` works.
import type { StoreFs } from '../conversationStore';

export class MemFs implements StoreFs {
  files = new Map<string, string>();
  dirs = new Set<string>(['/']);

  private err(c: string): Error {
    return Object.assign(new Error(c), { code: c });
  }

  private addDirs(p: string): void {
    let d = p.slice(0, p.lastIndexOf('/'));
    while (d) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
  }

  async readFile(path: string): Promise<string> {
    if (!this.files.has(path)) throw this.err('ENOENT');
    return this.files.get(path)!;
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.addDirs(path);
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<unknown> {
    let d = path;
    while (d) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
    return undefined;
  }

  async readdir(path: string): Promise<{ name: string; isDirectory(): boolean }[]> {
    if (!this.dirs.has(path)) throw this.err('ENOENT');
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) {
      if (f.startsWith(prefix) && f !== path) names.add(f.slice(prefix.length).split('/')[0]);
    }
    return [...names].map((name) => ({ name, isDirectory: () => this.dirs.has(prefix + name) }));
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw this.err('ENOENT');
  }
}
