# Vercel 部署说明

## 当前状态

本地已通过：

- Neon Postgres 表结构同步：`npx prisma db push`
- `npm run test:backend`
- `npm run build`
- 邮箱 + 密码注册登录 API
- 花束上传、生成、保存、删除、图鉴统计 API
- 图片存储已支持本地 `local`、Cloudinary 和 Cloudflare R2

## 线上必须配置的环境变量

在 Vercel Project Settings -> Environment Variables 中配置：

```env
DATABASE_URL="你的 Neon pooled connection string"
AI_PROVIDER="openai"
OPENAI_BASE_URL="你的 OpenAI 兼容网关地址"
OPENAI_IMAGE_API_KEY="你的生图 API Key"
OPENAI_VISION_API_KEY="你的视觉识别 API Key"
OPENAI_IMAGE_MODEL="gpt-image-2"
OPENAI_VISION_MODEL="mimo-v2-omni"
PUBLIC_APP_URL="https://你的-vercel-域名"

STORAGE_PROVIDER="cloudinary"
CLOUDINARY_CLOUD_NAME="你的 Cloudinary Cloud Name"
CLOUDINARY_API_KEY="你的 Cloudinary API Key"
CLOUDINARY_API_SECRET="你的 Cloudinary API Secret"

AUTH_COOKIE_NAME="flora_session"
SESSION_DAYS="30"
```

不要把真实 `DATABASE_URL`、`OPENAI_IMAGE_API_KEY`、`OPENAI_VISION_API_KEY`、`CLOUDINARY_API_SECRET` 提交到 GitHub。

## 登录方式

当前登录方式是邮箱 + 自定义密码：

- 新用户先注册，注册成功后自动登录。
- 老用户直接用邮箱和密码登录。
- 后端只保存 `passwordHash`，不保存明文密码。
- 未登录用户不能上传、生成、保存，也不能查看别人留下的花束记录。

## 图片存储选择

### 推荐：Cloudinary

你当前没有银行卡，所以推荐先用 Cloudinary。Cloudinary 免费档不需要信用卡，能直接拿到公开图片 URL，适合这个轻量 MVP 先上线。

在 Cloudinary 控制台拿这三项：

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

然后设置：

```env
STORAGE_PROVIDER="cloudinary"
CLOUDINARY_CLOUD_NAME="你的 Cloudinary Cloud Name"
CLOUDINARY_API_KEY="你的 Cloudinary API Key"
CLOUDINARY_API_SECRET="你的 Cloudinary API Secret"
```

配置后运行：

```bash
npm run check:storage
```

### 备用：Cloudflare R2

R2 免费额度很好，但 Cloudflare 激活 R2 时通常要求绑定付款方式。以后你有银行卡/PayPal 后，可以切换到 R2：

```env
STORAGE_PROVIDER="r2"
R2_ACCOUNT_ID="你的 Cloudflare Account ID"
R2_ACCESS_KEY_ID="你的 R2 Access Key ID"
R2_SECRET_ACCESS_KEY="你的 R2 Secret Access Key"
R2_BUCKET_NAME="flora-story"
R2_PUBLIC_BASE_URL="https://你的-r2-public-domain"
```

R2 控制台推荐选择：

- Bucket 名称：`flora-story`
- Storage class：`Standard`
- Location：如果有区域选项，选 `APAC`；没有就用自动推荐
- Public access：开启 `r2.dev` 公共访问，或绑定自定义域名
- API Token：R2 Object Read & Write，限制到这个 bucket

`R2_PUBLIC_BASE_URL` 要填公开访问域名，例如 `https://pub-xxxx.r2.dev` 或 `https://files.yourdomain.com`。
不要填 `https://<account-id>.r2.cloudflarestorage.com`，这个是 S3 API endpoint，浏览器和模型服务不能当作公开图片地址使用。

配置后可以先运行：

```bash
npm run check:storage
```

## 仍需完成

当前数据库已经迁到 Neon Postgres，图片存储已支持 Cloudinary/R2。正式上线前还需要：

- 域名：部署后把 `PUBLIC_APP_URL` 改成 Vercel 预览/生产域名。
- Vercel 环境变量：把 `.env.example` 里的线上变量逐项填到 Project Settings。

## 部署命令

如果本机安装并登录 Vercel CLI：

```bash
npm i -g vercel
vercel login
vercel deploy C:\Users\周平\Desktop\花历 -y
```

生产部署：

```bash
vercel deploy C:\Users\周平\Desktop\花历 --prod -y
```
