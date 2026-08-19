/**
 * 空模块。
 *
 * typescript.js 在浏览器里被打包时会 require 一堆 Node 内置模块（fs / os / path…），
 * 但 transpileModule 这条路径根本不会走到它们。webpack 用这个文件替换掉那些请求，
 * 替换只对 typescript 包生效，见 next.config.js。
 */
module.exports = {};
