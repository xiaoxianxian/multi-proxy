// 互通性验证 · node 侧（权威）
// 证明：JSON (canonical) <-> YAML (human view) 双向无损，且符合 JSON Schema。
// 依赖：全局 ~/node_modules 的 yaml + ajv（node v22）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const yaml = (await import(pathToFileURL(path.join(process.env.HOME, 'node_modules', 'yaml', 'dist', 'index.js')).href)).default;
const Ajv = (await import(pathToFileURL(path.join(process.env.HOME, 'node_modules', 'ajv', 'dist', 'ajv.js')).href)).default;

const ajv = new Ajv({ allErrors: true, strict: false });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}   ${name}${ok ? '' : '   -- ' + detail}`);
  if (!ok) failures++;
};

// 三件套：json(canonical) / yaml(view) / schema，文件名各不相同，整列出避免拼接歧义。
const specs = [
   { label: 'memory', json: 'agent-memory.json', yaml: 'agent-memory.yaml', schema: 'agent-memory.schema.json' },
   { label: 'skill',  json: 'skill.json',        yaml: 'skill.yaml',        schema: 'skill.schema.json' },
];

for (const { label, json: jf, yaml: yf, schema: sf } of specs) {
  const jsonDoc = JSON.parse(fs.readFileSync(path.join(dir, jf), 'utf8'));
  const yamlDoc = yaml.parse(fs.readFileSync(path.join(dir, yf), 'utf8'));
  const schemaDoc = JSON.parse(fs.readFileSync(path.join(dir, sf), 'utf8'));

   // 1. 两 view 解析结果一致（JSON 是 canonical，YAML 必须与之完全等价）
  const roundtripEq = JSON.stringify(jsonDoc) === JSON.stringify(yamlDoc);
  check(`${label}: JSON == YAML (parsed)`, roundtripEq,
    roundtripEq ? '' : `\njson=${JSON.stringify(jsonDoc)}\nyaml=${JSON.stringify(yamlDoc)}`);

   // 2. YAML 字符串 -> 对象 -> 写回 YAML，应与原文件语义一致（无损往返）
  const backToYaml = yaml.stringify(yamlDoc);
  const reparsed = yaml.parse(backToYaml);
  check(`${label}: YAML round-trip (object identical)`,
    JSON.stringify(reparsed) === JSON.stringify(yamlDoc));

   // 3. schema 校验（canonical JSON）
  const validate = ajv.compile(schemaDoc);
  const ok = validate(jsonDoc);
  check(`${label}: JSON valid against ${sf}`, ok, ok ? '' : JSON.stringify(validate.errors));

   // 4. 负例：破坏 specVersion 常量应被 schema 拒绝
  const bad = JSON.parse(JSON.stringify(jsonDoc));
  bad.specVersion = '9.9.9';
  const badOk = validate(bad);
  check(`${label}: bad specVersion rejected`, badOk === false);
}

console.log(failures === 0 ? '\nNODE: ALL PASS' : `\nNODE: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
