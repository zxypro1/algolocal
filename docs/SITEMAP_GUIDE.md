# Google Search Console 站点地图提交指南

## 步骤 1: 访问 Google Search Console
访问：https://search.google.com/search-console

## 步骤 2: 添加网站属性（如果还没有）
1. 点击左侧 "添加属性" 或 "Add property"
2. 选择 "网址前缀" (URL prefix)
3. 输入：`https://zxypro1.github.io/OfflineCodePractice`
4. 验证所有权：
   - 选择 "HTML 标记" (HTML tag) 方式
   - 你的网站已包含验证代码：`<meta name="google-site-verification" content="polTjQtkihIv7LZ-5RVl19ejDTy6ZU9TTX6xiDBKgUg" />`
   - 点击 "验证"

## 步骤 3: 提交站点地图
1. 在左侧菜单选择 "站点地图" (Sitemaps)
2. 在 "添加新的站点地图" 输入框中输入：`sitemap.xml`
3. 点击 "提交" (Submit)

## 步骤 4: 验证站点地图状态
提交后，Google 会显示：
- **成功**：状态为 "成功" 或 "Success"
- **警告**：可能有部分 URL 无法抓取（通常可忽略）
- **错误**：检查站点地图格式

## 步骤 5: 请求重新索引（可选）
如果站点地图已提交，但 Google 仍显示旧的标题：
1. 在 Search Console 左侧选择 "网址检查" (URL Inspection)
2. 输入你的网站 URL：`https://zxypro1.github.io/OfflineCodePractice/`
3. 点击 "请求编入索引" (Request Indexing)

## 站点地图位置
- **URL**: `https://zxypro1.github.io/OfflineCodePractice/sitemap.xml`
- **文件位置**: `docs/sitemap.xml`
- **自动发现**: 已在 `robots.txt` 中声明

## 预期结果
- Google 会在 1-2 天内抓取站点地图
- 索引更新可能需要几天到几周时间
- 可通过 Search Console 监控索引状态

