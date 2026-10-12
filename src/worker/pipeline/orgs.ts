/**
 * Companies the reader can show a logo for. The writer names each item's main company
 * ("org"); findOrg matches that name or a common alias and attaches the logo. A company
 * not listed here simply gets none. Logos come from scripts/logos.mjs (logo-data.ts).
 *
 * "domains" are sites that speak for the company. They only name a page the picker found
 * ("OpenAI" rather than "openai.com"); hosts that also carry other people's content
 * (huggingface.co, github.com, docs.google.com) are left out.
 */

import type { Org } from '../../shared/issue';
import { hostIs } from './feeds';
import { LOGOS, type LogoKey } from './logo-data';

interface OrgEntry {
  name: string;
  logo: LogoKey;
  aliases: string[];
  domains: string[];
}

export const ORGS: OrgEntry[] = [
  { name: 'OpenAI', logo: 'openai', aliases: ['ChatGPT'], domains: ['openai.com', 'chatgpt.com'] },
  { name: 'Anthropic', logo: 'anthropic', aliases: ['Claude'], domains: ['anthropic.com', 'claude.com', 'claude.ai'] },
  { name: 'Google', logo: 'google', aliases: ['Alphabet', 'Google Research', 'Google Cloud', 'Gemini', '谷歌'], domains: ['blog.google', 'research.google', 'ai.google', 'ai.google.dev', 'cloud.google.com', 'developers.googleblog.com', 'abc.xyz'] },
  { name: 'Google DeepMind', logo: 'deepmind', aliases: ['DeepMind'], domains: ['deepmind.google', 'deepmind.com'] },
  { name: 'Meta', logo: 'meta', aliases: ['Meta Platforms', 'Meta AI', 'Facebook', 'Llama'], domains: ['meta.com', 'about.fb.com', 'llama.com'] },
  { name: 'Microsoft', logo: 'microsoft', aliases: ['Microsoft AI', 'Microsoft Research', 'Azure', '微软'], domains: ['microsoft.com'] },
  { name: 'Apple', logo: 'apple', aliases: ['苹果'], domains: ['apple.com'] },
  { name: 'AWS', logo: 'aws', aliases: ['Amazon Web Services', 'Amazon Bedrock'], domains: ['aws.amazon.com'] },
  { name: 'NVIDIA', logo: 'nvidia', aliases: ['英伟达'], domains: ['nvidia.com'] },
  { name: 'AMD', logo: 'amd', aliases: ['Advanced Micro Devices'], domains: ['amd.com'] },
  { name: 'Intel', logo: 'intel', aliases: ['英特尔'], domains: ['intel.com'] },
  { name: 'Qualcomm', logo: 'qualcomm', aliases: ['高通'], domains: ['qualcomm.com'] },
  { name: 'Arm', logo: 'arm', aliases: ['Arm Holdings'], domains: ['arm.com'] },
  { name: 'Tesla', logo: 'tesla', aliases: ['特斯拉'], domains: ['tesla.com'] },
  { name: 'IBM', logo: 'ibm', aliases: [], domains: ['ibm.com'] },
  { name: 'Mistral AI', logo: 'mistral', aliases: ['Mistral'], domains: ['mistral.ai'] },
  { name: 'Hugging Face', logo: 'huggingface', aliases: [], domains: [] },
  { name: 'xAI', logo: 'xai', aliases: ['Grok'], domains: ['x.ai'] },
  { name: 'Perplexity', logo: 'perplexity', aliases: ['Perplexity AI'], domains: ['perplexity.ai'] },
  { name: 'Cohere', logo: 'cohere', aliases: [], domains: ['cohere.com'] },
  { name: 'Stability AI', logo: 'stability', aliases: [], domains: ['stability.ai'] },
  { name: 'Midjourney', logo: 'midjourney', aliases: [], domains: ['midjourney.com'] },
  { name: 'Runway', logo: 'runway', aliases: ['Runway ML', 'RunwayML'], domains: ['runwayml.com'] },
  { name: 'Cerebras', logo: 'cerebras', aliases: ['Cerebras Systems'], domains: ['cerebras.ai', 'cerebras.net'] },
  { name: 'Groq', logo: 'groq', aliases: [], domains: ['groq.com'] },
  { name: 'Cursor', logo: 'cursor', aliases: ['Anysphere'], domains: ['cursor.com'] },
  { name: 'GitHub', logo: 'github', aliases: ['GitHub Copilot'], domains: ['github.blog'] },
  { name: 'DeepSeek', logo: 'deepseek', aliases: ['深度求索'], domains: ['deepseek.com'] },
  { name: 'Alibaba', logo: 'alibaba', aliases: ['Alibaba Group', 'Alibaba Cloud', 'Aliyun', 'Qwen', 'Tongyi', '阿里巴巴', '阿里', '阿里云', '通义', '千问'], domains: ['alibabagroup.com', 'alibabacloud.com', 'aliyun.com', 'qwen.ai', 'qwenlm.github.io'] },
  { name: 'Tencent', logo: 'tencent', aliases: ['Tencent Holdings', 'Tencent Cloud', 'Hunyuan', '腾讯', '腾讯云', '混元'], domains: ['tencent.com'] },
  { name: 'Baidu', logo: 'baidu', aliases: ['ERNIE', '百度', '文心'], domains: ['ir.baidu.com', 'home.baidu.com', 'research.baidu.com', 'yiyan.baidu.com'] },
  { name: 'ByteDance', logo: 'bytedance', aliases: ['ByteDance Seed', 'Doubao', 'Volcano Engine', 'Volcengine', '字节跳动', '字节', '豆包', '火山引擎'], domains: ['bytedance.com', 'volcengine.com', 'doubao.com'] },
  { name: 'Zhipu AI', logo: 'zhipu', aliases: ['Zhipu', 'Z.ai', 'GLM', 'Knowledge Atlas', '智谱'], domains: ['zhipuai.cn', 'bigmodel.cn', 'z.ai'] },
  { name: 'Moonshot AI', logo: 'moonshot', aliases: ['Moonshot', 'Kimi', '月之暗面'], domains: ['moonshot.cn', 'moonshot.ai', 'kimi.com'] },
  { name: 'MiniMax', logo: 'minimax', aliases: ['稀宇科技'], domains: ['minimaxi.com', 'minimax.io'] },
  { name: 'StepFun', logo: 'stepfun', aliases: ['阶跃星辰'], domains: ['stepfun.com'] },
  { name: '01.AI', logo: 'zeroone', aliases: ['Lingyi Wanwu', '零一万物'], domains: ['01.ai', 'lingyiwanwu.com'] },
  { name: 'Baichuan', logo: 'baichuan', aliases: ['Baichuan AI', 'Baichuan Intelligence', '百川智能'], domains: ['baichuan-ai.com'] },
  { name: 'iFlytek', logo: 'iflytek', aliases: ['科大讯飞', '讯飞'], domains: ['iflytek.com', 'xfyun.cn'] },
  { name: 'Huawei', logo: 'huawei', aliases: ['Huawei Technologies', 'Huawei Cloud', 'Ascend', '华为'], domains: ['huawei.com', 'huaweicloud.com'] },
  { name: 'Xiaomi', logo: 'xiaomi', aliases: ['小米'], domains: ['mi.com', 'xiaomi.com'] },
  { name: 'Kuaishou', logo: 'kuaishou', aliases: ['Kling', 'Kling AI', '快手', '可灵'], domains: ['kuaishou.com', 'klingai.com'] },
  { name: 'Ant Group', logo: 'antgroup', aliases: ['蚂蚁集团'], domains: ['antgroup.com'] },
];

const LEGAL_SUFFIX = /[\s,]+(inc|incorporated|ltd|limited|llc|corp|corporation|co|plc)\.?$/i;

/** "NVIDIA Corp." and "Nvidia" are the same company; so are "Z.ai" and "z ai". */
export const orgKey = (name: string): string =>
  name.normalize('NFKC').trim().replace(LEGAL_SUFFIX, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const BY_KEY = new Map<string, OrgEntry>();
for (const entry of ORGS) for (const name of [entry.name, ...entry.aliases]) BY_KEY.set(orgKey(name), entry);

/** The listed company the writer named, with its logo; undefined for anyone else. */
export function findOrg(name: string | null | undefined): Org | undefined {
  const entry = name ? BY_KEY.get(orgKey(name)) : undefined;
  return entry ? { name: entry.name, logo: LOGOS[entry.logo] } : undefined;
}

/** The listed company whose own site this is. */
export function orgForUrl(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return ORGS.find((entry) => entry.domains.some((d) => hostIs(host, d)))?.name;
}
