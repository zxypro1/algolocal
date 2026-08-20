# 向 Google Search Console 提交站点地图

站点地图在 `docs/sitemap.xml`，线上地址是 `https://zxypro1.github.io/algolocal/sitemap.xml`，`robots.txt` 里已经声明过，所以 Google 也能自己发现它。手动提交只是让它早一点被抓到。

## 添加网站属性

打开 https://search.google.com/search-console，如果还没有这个站点的属性，点「添加属性」，选「网址前缀」，填 `https://zxypro1.github.io/algolocal/`。

验证方式选「HTML 标记」。页面里已经带了验证码，不用再改文件：

```html
<meta name="google-site-verification" content="polTjQtkihIv7LZ-5RVl19ejDTy6ZU9TTX6xiDBKgUg" />
```

## 提交

左侧菜单进「站点地图」，在输入框里填 `sitemap.xml`，提交。

提交后的状态有三种。「成功」就是抓到了。「警告」通常是部分 URL 抓不到，一般可以不管。「错误」说明格式有问题，回去检查 `docs/sitemap.xml`。

## 让某个页面重新索引

改了标题或描述之后，Google 可能还显示旧的。左侧选「网址检查」，输入 `https://zxypro1.github.io/algolocal/`，点「请求编入索引」。

## 大概多久

站点地图一般 1 到 2 天内被抓取，索引更新则可能要几天到几周。进度在 Search Console 里能看到。
