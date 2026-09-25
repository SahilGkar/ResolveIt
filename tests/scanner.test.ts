import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanWorkspace } from '../src/scanners/index.js';
import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `resolveit-test-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeFile(dir: string, path: string, content: string): Promise<void> {
  const fullPath = join(dir, path);
  await fs.mkdir(resolve(fullPath, '..'), { recursive: true });
  await fs.writeFile(fullPath, content);
}

describe('scanner', () => {
  let testDir: string;
  
  beforeEach(async () => {
    testDir = await createTempDir();
  });
  
  afterEach(async () => {
    await cleanupDir(testDir);
  });
  
  it('should scan an empty workspace', async () => {
    const result = await scanWorkspace(testDir);
    
    expect(result.rootPath).toBe(resolve(testDir));
    expect(result.projects).toHaveLength(1);
    expect(result.allFiles).toHaveLength(0);
    expect(result.allDirectories).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
  
  it('should scan a workspace with multiple files', async () => {
    await writeFile(testDir, 'src/main.ts', 'console.log("hello");');
    await writeFile(testDir, 'src/utils.ts', 'export const x = 1;');
    await writeFile(testDir, 'package.json', '{"name": "test"}');
    await writeFile(testDir, 'README.md', '# Test');
    
    const result = await scanWorkspace(testDir);
    
    expect(result.allFiles.length).toBeGreaterThanOrEqual(4);
    expect(result.projectMarkers.length).toBeGreaterThanOrEqual(1);
    expect(result.languages.some(l => l.id === 'typescript')).toBe(true);
  });
  
  it('should detect nested directories', async () => {
    await writeFile(testDir, 'src/main.ts', 'console.log("hello");');
    await writeFile(testDir, 'src/components/button.tsx', 'export const Button = () => <button />;');
    await writeFile(testDir, 'tests/main.test.ts', 'test("test", () => {});');
    
    const result = await scanWorkspace(testDir);
    
    expect(result.allDirectories.some(d => d.relativePath.includes('src'))).toBe(true);
    expect(result.allDirectories.some(d => d.relativePath.includes('tests'))).toBe(true);
  });
  
  it('should detect languages from file extensions', async () => {
    await writeFile(testDir, 'main.py', 'print("hello")');
    await writeFile(testDir, 'script.js', 'console.log("hello")');
    await writeFile(testDir, 'style.css', 'body {}');
    await writeFile(testDir, 'data.json', '{}');
    
    const result = await scanWorkspace(testDir);
    
    const langIds = result.languages.map(l => l.id);
    expect(langIds).toContain('python');
    expect(langIds).toContain('javascript');
    expect(langIds).toContain('css');
    expect(langIds).toContain('json');
  });
  
  it('should detect project markers', async () => {
    await writeFile(testDir, 'package.json', '{"name": "test"}');
    await writeFile(testDir, 'requirements.txt', 'requests==2.28.0');
    await writeFile(testDir, 'Cargo.toml', '[package]\nname = "test"');
    
    const result = await scanWorkspace(testDir);
    
    const markerTypes = result.projectMarkers.map(m => m.type);
    expect(markerTypes).toContain('package-json');
    expect(markerTypes).toContain('requirements-txt');
    expect(markerTypes).toContain('cargo-toml');
  });
  
  it('should classify source files', async () => {
    await writeFile(testDir, 'src/main.ts', 'console.log("hello");');
    await writeFile(testDir, 'src/utils.ts', 'export const x = 1;');
    await writeFile(testDir, 'tests/main.test.ts', 'test("test", () => {});');
    await writeFile(testDir, 'README.md', '# Test');
    await writeFile(testDir, 'config.json', '{}');
    
    const result = await scanWorkspace(testDir);
    
    const project = result.projects[0];
    expect(project.sourceFiles.length).toBeGreaterThanOrEqual(2);
    expect(project.testFiles.length).toBeGreaterThanOrEqual(1);
    expect(project.documentationFiles.length).toBeGreaterThanOrEqual(1);
    expect(project.configFiles.length).toBeGreaterThanOrEqual(1);
  });
  
  it('should exclude ignored directories', async () => {
    await writeFile(testDir, 'src/main.ts', 'console.log("hello");');
    await writeFile(testDir, 'node_modules/pkg/index.js', 'module.exports = {};');
    await writeFile(testDir, 'dist/bundle.js', 'console.log("built");');
    await writeFile(testDir, '.git/config', '[core]');
    
    const result = await scanWorkspace(testDir);
    
    const nodeModulesFiles = result.allFiles.filter(f => f.relativePath.includes('node_modules'));
    const distFiles = result.allFiles.filter(f => f.relativePath.includes('dist'));
    const gitFiles = result.allFiles.filter(f => f.relativePath.includes('.git'));
    
    expect(nodeModulesFiles).toHaveLength(0);
    expect(distFiles).toHaveLength(0);
    expect(gitFiles).toHaveLength(0);
    expect(result.allFiles.some(f => f.relativePath === 'src/main.ts')).toBe(true);
  });
  
  it('should detect .env files without exposing contents', async () => {
    await writeFile(testDir, '.env', 'SECRET_KEY=supersecret\nAPI_KEY=abc123');
    await writeFile(testDir, '.env.example', 'SECRET_KEY=\nAPI_KEY=');
    
    const result = await scanWorkspace(testDir);
    
    const envFiles = result.configFiles.filter(c => c.type === 'env');
    expect(envFiles.length).toBe(1);
    expect(envFiles[0].path).toBe('.env');
    
    const envExampleFiles = result.configFiles.filter(c => c.type === 'env-example');
    expect(envExampleFiles.length).toBe(1);
  });
  
  it('should handle unknown file types', async () => {
    await writeFile(testDir, 'data.xyz', 'unknown content');
    await writeFile(testDir, 'script.unknown', 'more content');
    
    const result = await scanWorkspace(testDir);
    
    expect(result.allFiles.length).toBe(2);
    const unknownFiles = result.allFiles.filter(f => f.classification === 'unknown');
    expect(unknownFiles.length).toBe(2);
  });
  
  it('should throw for missing workspace', async () => {
    const missingPath = join(tmpdir(), `resolveit-missing-${randomUUID()}`);
    
    await expect(scanWorkspace(missingPath)).rejects.toThrow('Workspace not found');
  });
  
  it('should throw for file instead of directory', async () => {
    const filePath = join(tmpdir(), `resolveit-file-${randomUUID()}.txt`);
    await fs.writeFile(filePath, 'test');
    
    try {
      await expect(scanWorkspace(filePath)).rejects.toThrow('not a directory');
    } finally {
      await fs.unlink(filePath);
    }
  });
  
  it('should handle permission errors gracefully', async () => {
    // Skip on Windows as permission model is different
    if (process.platform === 'win32') {
      return;
    }
    
    const restrictedDir = join(testDir, 'restricted');
    await fs.mkdir(restrictedDir);
    await fs.chmod(restrictedDir, 0o000);
    
    try {
      await writeFile(testDir, 'src/main.ts', 'console.log("hello");');
      await writeFile(restrictedDir, 'secret.txt', 'secret');
      
      const result = await scanWorkspace(testDir);
      
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.code === 'DIR_READ_ERROR')).toBe(true);
    } finally {
      await fs.chmod(restrictedDir, 0o755);
    }
  });
  
  it('should output JSON serializable results', async () => {
    await writeFile(testDir, 'package.json', '{"name": "test"}');
    await writeFile(testDir, 'src/main.ts', 'console.log("hello");');
    
    const result = await scanWorkspace(testDir);
    
    expect(() => JSON.stringify(result)).not.toThrow();
    
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.rootPath).toBe(result.rootPath);
    expect(parsed.projects).toHaveLength(result.projects.length);
  });
  
  it('should respect maxDepth option', async () => {
    await writeFile(testDir, 'a/b/c/d/e/f/deep.ts', 'console.log("deep");');
    
    const result = await scanWorkspace(testDir, { maxDepth: 3 });
    
    const deepFile = result.allFiles.find(f => f.relativePath.includes('deep.ts'));
    expect(deepFile).toBeUndefined();
  });
  
  it('should respect maxFiles option', async () => {
    for (let i = 0; i < 15; i++) {
      await writeFile(testDir, `file${i}.txt`, `content ${i}`);
    }
    
    const result = await scanWorkspace(testDir, { maxFiles: 5 });
    
    expect(result.allFiles.length).toBeLessThanOrEqual(5);
  });
  
  it('should detect repo indicators', async () => {
    await writeFile(testDir, '.git/config', '[core]');
    await writeFile(testDir, '.github/workflows/ci.yml', 'name: CI');
    await writeFile(testDir, 'Jenkinsfile', 'pipeline {}');
    
    const result = await scanWorkspace(testDir);
    
    const repoTypes = result.repoIndicators.map(r => r.type);
    expect(repoTypes).toContain('git');
    expect(repoTypes).toContain('github-workflows');
    expect(repoTypes).toContain('jenkinsfile');
  });
  
  it('should identify multiple projects in workspace', async () => {
    await writeFile(testDir, 'frontend/package.json', '{"name": "frontend"}');
    await writeFile(testDir, 'frontend/src/main.ts', 'console.log("frontend");');
    await writeFile(testDir, 'backend/Cargo.toml', '[package]\nname = "backend"');
    await writeFile(testDir, 'backend/src/main.rs', 'fn main() {}');
    
    const result = await scanWorkspace(testDir);
    
    expect(result.projects.length).toBeGreaterThanOrEqual(2);
    const projectTypes = result.projects.map(p => p.type);
    expect(projectTypes).toContain('npm');
    expect(projectTypes).toContain('cargo');
  });
});