/**
 * The privacy page, in both languages. It promises what the code does: the retention
 * periods are enforced by src/worker/retention.ts, the processors are the services the
 * worker calls, and the controller and contact match Manyfold's own privacy policy
 * (docs.manyfold.ai/privacy) and the postal address in every email (wrangler.jsonc).
 * Change them together.
 */

import type { Lang } from '../../shared/issue';

export const PRIVACY_UPDATED: Record<Lang, string> = { en: 'Last updated 13 October 2026.', zh: '最后更新：2026 年 10 月 13 日。' };

export const PRIVACY: Record<Lang, { heading: string; body: string[] }[]> = {
  en: [
    {
      heading: 'Who we are',
      body: [
        'AI in 5 is published by NetMind.AI Ltd (company number 13588608), 6th Floor, 75 King William Street, London EC4N 7BE, United Kingdom, the company behind Manyfold. We are the controller of the personal data described here, under the UK GDPR and, where it applies, the EU GDPR.',
        'Questions and requests: customer-support@netmind.ai.',
      ],
    },
    {
      heading: 'What we keep, and why',
      body: [
        'Your email address, with the language and time zone your browser reported, when you subscribe. We use it only to send the daily issue at 7:00 your time and the confirmation and sign-in links you ask for. We rely on your consent, which you give by confirming your address; you can withdraw it at any time by unsubscribing.',
        'The questions you ask about a story. They go to the AI that answers them without your address, and we store them with a scrambled code (a salted hash) instead of your address, to apply the daily limit and to reuse answers.',
        'Which issues a subscriber opens on the site, stored with the same scrambled code, so we can tell whether the briefing is worth reading. This is our legitimate interest in improving it; we never use it for advertising.',
        'Counts of page views, finished reads, shares, “useful” votes and problem reports. These are daily totals and cannot be linked to anyone.',
        'A scrambled code made from your IP address, kept for one day, to stop abuse of the forms. We never store the address itself.',
        'We set no cookies and use no advertising or third-party tracking. Our emails carry no tracking pixels, and their links go straight to our site, not through a tracker. Your browser keeps your language choice and, once you subscribe, a sign-in key in its own storage; that key is how the site knows a subscriber opened an issue, and signing out removes it.',
      ],
    },
    {
      heading: 'Who handles it for us',
      body: [
        'Cloudflare hosts the site and its database and runs the check on the subscribe form that tells people from bots (Cloudflare Turnstile).',
        'Resend sends our emails.',
        'Manyfold runs the AI agents that write the issue and answer questions, and passes questions to the AI model provider behind the answering agent. Neither receives your email address.',
        'These providers may process data outside the UK and the EU, under the safeguards the law requires, such as standard contractual clauses. We never sell personal data or share it for marketing.',
      ],
    },
    {
      heading: 'How long we keep it',
      body: [
        'Subscribers: until you unsubscribe. Addresses that were never confirmed, unsubscribed, or bounced are deleted 30 days after their last change.',
        'The record of which emails we sent you: 90 days.',
        'Your questions, and which issues you opened: 90 days.',
        'Your answer to “how would you feel if AI in 5 stopped”: until your address is deleted.',
        'The scrambled IP code: one day.',
      ],
    },
    {
      heading: 'Your choices and rights',
      body: [
        'Every email has a one-click unsubscribe link. On the page it opens, “Unsubscribe and delete my data” deletes your address and everything linked to it at once.',
        'You can also ask us for a copy of your data, to correct it, to delete it, or object to how we use it, by writing to customer-support@netmind.ai. We answer within one month.',
        'If you think we have not handled your data properly, you can complain to the UK Information Commissioner’s Office (ico.org.uk) or the data protection authority where you live.',
      ],
    },
    {
      heading: 'Changes',
      body: ['If we change how we handle your data, we will update this page first, and tell subscribers by email about any change that matters.'],
    },
  ],
  zh: [
    {
      heading: '我们是谁',
      body: [
        'AI in 5 由 NetMind.AI Ltd（公司编号 13588608，地址：6th Floor, 75 King William Street, London EC4N 7BE, United Kingdom）出品，也就是 Manyfold 背后的公司。根据英国 GDPR 以及适用时的欧盟 GDPR，我们是本页所述个人数据的控制者。',
        '如有问题或请求，请写信至 customer-support@netmind.ai。',
      ],
    },
    {
      heading: '我们保存什么，为什么',
      body: [
        '你订阅时填写的邮箱地址，以及浏览器提供的语言和时区。我们只用它来在你的当地时间早上 7 点发送每日简报，以及发送你申请的确认链接和登录链接。依据是你的同意，你在确认邮箱时给出；随时退订即可撤回。',
        '你就新闻提出的问题。问题发给负责回答的 AI 时不附带你的邮箱；保存时用一个加密处理过的代码（加盐哈希）代替邮箱，用于执行每日次数限制和复用答案。',
        '订阅者在网站上打开了哪几期，同样只用这个代码保存，用来判断简报是否值得读。这是我们改进产品的正当利益，绝不用于广告。',
        '浏览、读完、分享、"有用"投票和报错的次数。这些都是按天汇总的总数，无法对应到任何人。',
        '由你的 IP 地址生成的加密代码，只保存一天，用来防止表单被滥用。我们从不保存 IP 地址本身。',
        '我们不使用 Cookie，不使用任何广告或第三方追踪。邮件里没有追踪像素，邮件中的链接直接指向我们的网站，不经过任何追踪跳转。你的浏览器会在本地保存你选择的语言，订阅后还会保存一个登录密钥；网站正是通过这个密钥知道某位订阅者打开了某一期，在这台设备上退出即可删除它。',
      ],
    },
    {
      heading: '谁替我们处理数据',
      body: [
        'Cloudflare：托管网站和数据库，并在订阅表单上运行人机验证（Cloudflare Turnstile）。',
        'Resend：发送邮件。',
        'Manyfold：运行撰写简报和回答问题的 AI 智能体，并把问题转给回答智能体背后的 AI 模型提供商。它们都拿不到你的邮箱地址。',
        '这些服务商可能在英国和欧盟以外处理数据，并按法律要求采取保护措施，例如标准合同条款。我们从不出售个人数据，也不会为营销目的分享。',
      ],
    },
    {
      heading: '保存多久',
      body: [
        '订阅者：直到你退订为止。从未确认、已退订或投递失败的邮箱，在最后一次变动 30 天后删除。',
        '给你发过哪些邮件的记录：90 天。',
        '你提过的问题，以及你打开过哪几期：90 天。',
        '你对"如果 AI in 5 停更你会怎样"的回答：与邮箱地址一同删除。',
        '由 IP 生成的加密代码：1 天。',
      ],
    },
    {
      heading: '你的选择和权利',
      body: [
        '每封邮件都有一键退订链接。在打开的页面上选择"退订并删除我的数据"，你的邮箱以及与之相关的所有记录会立即删除。',
        '你也可以写信至 customer-support@netmind.ai，要求获取你的数据副本、更正、删除，或反对我们使用这些数据。我们会在一个月内答复。',
        '如果你认为我们没有妥善处理你的数据，可以向英国信息专员办公室（ico.org.uk）或你所在地的数据保护机构投诉。',
      ],
    },
    {
      heading: '变更',
      body: ['如果我们改变处理数据的方式，会先更新本页；对你有实质影响的变更，会通过邮件告知订阅者。'],
    },
  ],
};
