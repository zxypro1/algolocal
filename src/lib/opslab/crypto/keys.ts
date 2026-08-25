/**
 * 预先生成的 RSA-2048 密钥对
 *
 * 为什么写死而不是运行时生成：**确定性**。同一个世界重放两次，证书的字节
 * 必须一模一样，否则 golden 比对与进度恢复都塌了。而真正生成一对 RSA 密钥
 * 需要找素数，既慢又必然随机。
 *
 * 这些是货真价实的密钥（Node 的 crypto 生成的），签出来的证书用任何真实的
 * 验证器都验得过 —— 我们只是不在运行时造它们。密钥按需要轮着用，
 * 所以不同的证书拿到的是不同的密钥。
 */

export interface RsaKeyPair {
  /** 模数，base64url */
  n: string;
  /** 公钥指数，base64url（都是 65537） */
  e: string;
  /** 私钥指数，base64url */
  d: string;
}

export const KEY_POOL: RsaKeyPair[] = [
  {
    n: '58JP1X9EK3058ubDi8wOMtwIqu3OS--F_nfyFRacEglz8McnrfdcV8PDU2T4XAyS6_H44a3BL1qTWVG4ojmoggKwMTyDaXx2tY7xgTzcoZPbTH1gQ-y0Y3DfVmmgmMaEeia6_MWlwykKg6Gz9-87n7k5CWBDxDRAgR2O_Gfn1tMiudDvfqUhoAiJmXS3B8emWSeDlE6C_cxM9T640akhmASjiwg1pfOPqUTIfCuhDzeQ1nwSjlnwPmT4UsvHppT9waNeWV7jhe1qqjYT0MfSm7UVIdBIntEWfaT_CSAVM3eOw7kh1q-95dZJNQ2MSEvxG8RgXGz8XdQhy6OxHsjtdQ',
    e: 'AQAB',
    d: 'BtSTvMOU80EsEYwajEa1zmrsuHjswREsnkzTript7BwqNhjwgvCM4KtM2OrbZP8b32dQwfn4fRhKynGdou5XGInSvoi9iMDZ0M0HMhtkl0B_0JfLXAUgZePgOTBAwu_q3JzCmwuKMJ_HhwyffLmoxLLVSwDyzlgJ5KRF4AuB6jNdbbkerH04s2htwWBxr_YEdURU8sc7ZQ7jENydf-qKKZaM5H6dEGlXCU_Rb7Ay1ARCbaeaUfaXwVgA0zD0BKArA_tbpwQkiINZtQ1OZaWChsYn0CjZlF6X2sNl6B0sC2nGmna3l5fo27gImXqi03w047tAQH3VpEXjc6KBKufckQ',
  },
  {
    n: '4ReDd-Apz9rmPSrg9iGbzWav7KDJCezku9iO8fhOKrXfLeh4_FeeHGmjHWuts3Xh56gvz_3_-rJbZexuFhd8-gWmHdN3RFSk_e2CNVwLLuf1s9ZOz-jE-3MEk23n7MwTVFKu9t8rCZwnWUW5sZACSDH3emOJuNbkyrIvR77549hxCOONq961bJgSAHM4yJLmC7KLXwwVcknAoKofpeQigzevR4j-1xlVRGoLAdbduPLYNjU7Hpl4348W-UDtuUGsJ9pbUWT4JXXX6OJLOM9NVeU0kzHahzAJkZhv10NaJRBOD5_j8niLgSABtxEdpNGPXX-VvRYRNu0KZq_o1rxhRQ',
    e: 'AQAB',
    d: 'FMwh4XRMsky08KdJR6SXHmIKOv0nv7frvtZFbhXPTxxXy-7Kj78FHlxXITN4rKsYxAxvqOWWMbkqDB-AxzmRwN4lv5eK0dbws0xiUM2gDbKKXeMdJaujPuJp_h86o-mLl0M-feCxbsvG41vRMP1JbX2kZcjUCeHDgpD2umFqxsJ_J_XLd7Bf2x8qardaNWAGOeyrElDlqJkOfwezWumTUH6li4bliV01u3hVCzuyP85gDUzZdW69qRojUnAldpWQEbkZlzOGNOszUNnYQccxtPLYlmx3gtQmP_Gua0EqQ6su6qox64Pz2uonCqJcSd4_1IW5lpunxS3UMCj3lg_qPw',
  },
  {
    n: '47zsTyIDb2y9P-DHqzncvQiatvwJU4D3JrfoF5bU-_QK81f44caeI9jFudOUedEUmu014QstHohtoGakeuiZ0RaNnOHokOSR9BgEkB28b5yJZ0ifqgJ5R2Jk7yeirvif9bl23Y1lTtdnIi6cIziTlwpGboFsYW6hUd8307-8HLqPvOYKhYYoE5tmTZf1aHToXWBPurIpkByVgqZdsnEeSaHMai0b8m82UlIcgXkDJ90RhYD-CZfLD4WF72B7DPUSayn4ukPiqbNPYJWEdam83cxPITFMU4J18WF6oBCTDDIMGSWxF1uzXrThtNuVUB4I10lX7Syf3fukLxzUh0DObw',
    e: 'AQAB',
    d: 'U5TQM6C7mwbRFCMWlNB5I4WHZrXsZFG2I2cmjpXEWC3yYOn-BTrEakqSEsfEu8qQ4eVCO3RDHGwcs9xH7HX2kebRlWzR0m-Y43l3Hz9Sm7HbOeVM9_PNd_X0LlOhIM9NwbzOE7TjpAJpLwHlOwX2IN5cCA2G7eFQ4n_meNfrHa1nSN31-rbL7HUdeCUUmduN_B_HzcGFRRLLXgyVJ-l862atCNs67ndnsNP4-cYsMP7BXEWBRDJf_Ky8poFOwTTAq1ek6vocBWWbGq3lE_eG4izaYDX1mL6PXRM-hQjC_2fkVBzsgyplQZ87hIebJTouOk77zhpG3tb1wp3eta6tFQ',
  },
  {
    n: 'qefKoe82L4Is4hk1XwUBlD1xOKfv6SZImENVFtFps5Mh6VxhuY9EEq_giD0HxsKz84dOfeehy_v3CUu2TgrTiIkcA1hhRHwz-QZfUeQciEvYCdExrQFKwVVGSgos8PfNtPIDLIKVBgL-gGx_n7elbK83vNKI5cZ7tviA6IbSFCUiDC2vttXItx7EfsSNt6igVy_SMZKsAQAEnGm_wujtLlMPhb57umgaIBxCOCDHxYFNir9lC87PFvip0qrDmruGWocdlrzh2SpsGdr8Gb54jewtPVMB2HesefZVZGZfe5k8XCzZqRVsyknQwnojQVbEFs5ovW_ZSJnz_-DmiFj5UQ',
    e: 'AQAB',
    d: 'S1NPG7HQ5QkiWu7wIXs3sv_2dTbG_yeQ4ahgTehzo0BktW_Wh4zDkkFVGzFrhCwH2bywCNOrgKLpZ76gSUM1ev_GYplJLjKeXBX-JnEqUSbG1btf-aJsAQCMVADk4cQK9-CflZki9nJXYJo5jpa9iUy5OkZgmPYBHSJZDD3RX0pIafswvaV13sDuBYzc6tkR-5Nq8gSR7dn5oZDYLOnoZYqa1M40VyXxQj3CksGsgIUIKxeQWBmj54Ygo8o3M_K7Dcf5K5qVQi7mYrvVXCgDfpSN8WEB-VxJvnsWRQWAjTexuKc3bRyy0OWEg-RBLE3-7holyKdHlC11Z3goByMETQ',
  },
  {
    n: 'i9O0ff_ZG_tOb-jJEmmXjjI5Nt1oW5GC6Bcp2C3wFIR77uJC_NnU54EOSnX1Vjo3-Xn1gnudIi7qO2-gQMdkVKQCOXahAbC6B8qtCYQqif1jU3u4PC-pHtbLtUbc3VL15eRva1qrRDTxs05AZ5fjQxlDcELbINXZJAp25an7_I-EDxbfmer3272DpluJMl65ZvPO93iAPmbkSLd8LTxGwtOgTY7JSsM41r4LwZ4WtrbCo1H0je_8ROFNu499SP1aZv5MigG-l27bo5vEbv2Lp9HjDAhVeXfHytO9ANMmpz2MO3mRKQGNLm7duDXwTQ3JSXQOr1J5Xhf-NTUhIJ-tGw',
    e: 'AQAB',
    d: 'IkbT9J0-2iKpUDqm68oRumxqZR4yglvx1LY07kcYltcBUIaLuFMn41ZaK_utmCUuaowwmHt4AhSxG7_Z73dRi4Qm_XIstu7dM6LF91K8YNZKPoFSIQLn-OTbzATiiKjZGbF9dLolyNMXuwZAOITd06mCRCdHc02o7LJaAiPA32DsRJPLY28ChV3S0zm4dLCw0EHuYgXXZ8sfOO77pEzHgNpcMbQoVKL6WqHFJvvhRfaxRc1KIxedTpe1P7eur_WkbP9YPK70rgHbPKlfjtMTTYnWPmd8hhf9IKfXkgM8CViJZqsJ8Uw8YXgcZa9a0PK9i3dhfOFumGfTCBNMN3kxRQ',
  },
  {
    n: '_4ExXtbfy51iln5I1Er-f4ibjncNQXNVTHS5R_-_3AwjzBfKA57cQR7d0zlMby4vUcjGhhDwEOJ0S-j8c7FHVRHvyM3B3WUwhoJ2jWM9NIJGL74DqlbYhmYxBkF4bfyvTA_XxQ4XZdh4rMbvNdfSuCzuMQBL__8wtqCSpysaTXfEHhkHZD1g2wynAjdaTXGyrgdvkhwvwGGqfpg7_pZ-SrHSvek7l_W-k5bCGx3SBNT_8ME4CegirMMI3SxrZeIpV_Ynxv1i7C_AjM_rTc5mx78nWxsoyxndWNejqxJ5IaKXSytezsi20ZFuXrCutb0k25X5_jGzuzq187kYkKB42Q',
    e: 'AQAB',
    d: 'FOMm4Hq7onwKfZ5Aerpp9VsUyTmKTkamobCl61dJA_nDsDRk22IdRDJilMxWWn0-eRBRlzXDQ_eyfviPZGKihjduw5rhtYutwxFFrjR_e5w6yKRfM4mt-2Hw5Nk6H_B_eorBBOb5NEyiCnd1qF0tNZYJ7HX6jVvIGH-MymwhPLvbIUnFEvqn1a_Sk1za_-77VXiEOjl4qR_aW0lG3XKCZN6XqM57ecYNWwDrSP8yG1-iI9PFm_FPPb9gTvSqlbtZGGImzlT2ijlXmGAxcdzl_cU_5XuCebdVGLG2tRdTPLVN4TAFrw0tTdJWIyULdFNjuqEfsInVdxgEVih5xGFa0Q',
  },
];

/** 按一个稳定的名字取密钥，同样的名字永远拿到同一对 */
export function keyFor(name: string): RsaKeyPair {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return KEY_POOL[hash % KEY_POOL.length];
}
