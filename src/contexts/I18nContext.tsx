import React, { createContext, useContext, ReactNode, useState, useEffect } from 'react';
import { useRouter } from 'next/router';
// Dynamically import locale files
import en from '../../locales/en.json';
import zh from '../../locales/zh.json';

// Key for localStorage
const LOCALE_STORAGE_KEY = 'app-locale';

type Translations = {
  common: {
    language: string;
    theme: string;
    light: string;
    dark: string;
    home: string;
    loading: string;
    error: string;
    success: string;
    settings: string;
  };
  header: {
    title: string;
    subtitle: string;
  };
  statsPage?: {
    title: string;
    subtitle: string;
  };
  homepage: {
    title: string;
    subtitle: string;
    problemList: string;
    problems: string;
    addProblem: string;
    search: string;
    aiGenerator: string;
    problemStatus?: {
      attempted: string;
      solved: string;
    };
    searchPlaceholder: string;
    filterByDifficulty: string;
    filterByTags: string;
    allDifficulties: string;
    allTags: string;
    clearFilters: string;
    noResults: string;
    showingResults: string;
    of: string;
    stats?: {
      title: string;
      subtitle: string;
      jumpToDashboard: string;
      last7Days: string;
      last30Days: string;
      clear: string;
      today: string;
      todayAttempted: string;
      todaySolved: string;
      todaySubmissions: string;
      todayCorrectSubmissions: string;
      trend: string;
      unitProblems: string;
      attemptedTrend: string;
      solvedTrend: string;
      submissionsTrend: string;
      correctSubmissionsTrend: string;
      summary: string;
      rangeAttempted: string;
      rangeSolved: string;
      accuracy: string;
      rangeSubmissions: string;
      rangeCorrectSubmissions: string;
      submissionAccuracy: string;
      todayProblems: string;
      uniqueProblemsTip: string;
      recentSubmissions: string;
      recentSubmissionsTip: string;
      tests: string;
      language: string;
      execTime: string;
      correct: string;
      wrong: string;
      empty: string;
      solved: string;
      unsolved: string;
      attempts: string;
      more: string;
    };
    difficulty: {
      Easy: string;
      Medium: string;
      Hard: string;
    };
  };
  problemPage: {
    description: string;
    examples: string;
    solution: string;
    solutions?: string;
    showSolution: string;
    hideSolution: string;
    solutionHidden: string;
    example: string;
    input: string;
    output: string;
    solutionTitle?: string;
    noSolutions?: string;
  };
  codeRunner: {
    title: string;
    submit: string;
    running: string;
    testResults: string;
    passed: string;
    failed: string;
    testCase: string;
    expected: string;
    actual: string;
    executionTime: string;
    ms: string;
    runningTests: string;
    runError: string;
    networkError: string;
    totalExecutionTime: string;
    averageTime: string;
    memoryUsed: string;
    totalMemory: string;
    input: string;
    copy: string;
    copied: string;
  };
  aiGenerator: {
    title: string;
    subtitle: string;
    backToHome: string;
    tryLastProblem: string;
    requestLabel: string;
    requestPlaceholder: string;
    suggestedRequests: string;
    generateButton: string;
    generating: string;
    cancel: string;
    errorTitle: string;
    successTitle: string;
    previewTitle: string;
    problemId: string;
    howToUse: string;
    instruction1: string;
    instruction2: string;
    instruction3: string;
    instruction4: string;
    instruction5: string;
    pleaseEnterRequest: string;
    poweredBy: string;
    unlimitedProblems: string;
  };
  settings: {
    title: string;
    description: string;
    save: string;
    saving: string;
    deepseek: {
      apiKey: string;
      apiKeyPlaceholder: string;
      model: string;
      modelPlaceholder: string;
      timeout: string;
      timeoutPlaceholder: string;
      maxTokens: string;
      maxTokensPlaceholder: string;
    };
    openai: {
      apiKey: string;
      apiKeyPlaceholder: string;
      model: string;
      modelPlaceholder: string;
    };
    qwen: {
      apiKey: string;
      apiKeyPlaceholder: string;
      model: string;
      modelPlaceholder: string;
    };
    claude: {
      apiKey: string;
      apiKeyPlaceholder: string;
      model: string;
      modelPlaceholder: string;
    };
    ollama: {
      endpoint: string;
      endpointPlaceholder: string;
      model: string;
      modelPlaceholder: string;
    };
  };
  tags: {
    [key: string]: string;
  };
  /** 工程实战模块的文案，层级较深，这里不再逐字段展开 */
  engineering?: Record<string, any>;
  addProblem: {
    title: string;
    manualForm: string;
    importJson: string;
    uploadJsonFile: string;
    selectJsonFile: string;
    pasteJson: string;
    importJsonButton: string;
    basicInformation: string;
    problemId: string;
    problemIdHint: string;
    difficulty: string;
    titles: string;
    englishTitle: string;
    chineseTitle: string;
    tagsLabel: string;
    tagsPlaceholder: string;
    descriptions: string;
    englishDescription: string;
    chineseDescription: string;
    testCases: string;
    input: string;
    expectedOutput: string;
    removeTestCase: string;
    addTestCase: string;
    addProblemButton: string;
    addingProblem: string;
    problemAddedSuccess: string;
    invalidJsonFormat: string;
    jsonImportedSuccess: string;
    networkError: string;
    backToProblems: string;
  };
};

interface I18nContextType {
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  switchLocale: (locale: string) => void;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

// Load translations from locale files
const translations: Record<string, Translations> = {
  en,
  zh
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  
  // Initialize locale from localStorage or router, defaulting to 'zh'
  const [locale, setLocale] = useState<string>('zh');
  const [mounted, setMounted] = useState(false);

  // Load locale from localStorage on mount
  useEffect(() => {
    setMounted(true);
    if (typeof window !== 'undefined') {
      const savedLocale = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (savedLocale && (savedLocale === 'zh' || savedLocale === 'en')) {
        setLocale(savedLocale);
      } else if (router.locale) {
        setLocale(router.locale);
      }
    }
  }, [router.locale]);

  const t = (key: string, params?: Record<string, string | number>): string => {
    try {
      const keys = key.split('.');
      const currentLocale = mounted ? locale : 'zh';
      let value: any = translations[currentLocale];
      
      for (const k of keys) {
        if (value && typeof value === 'object') {
          value = value[k];
        } else {
          break;
        }
      }
      
      if (typeof value === 'string') {
        // 简单的参数替换
        if (params) {
          return Object.entries(params).reduce(
            (str, [paramKey, paramValue]) => 
              str.replace(`{{${paramKey}}}`, String(paramValue)),
            value
          );
        }
        return value;
      }
      
      // 如果找不到翻译，返回key或者使用中文作为fallback
      if (currentLocale !== 'zh') {
        let fallbackValue: any = translations.zh;
        for (const k of keys) {
          if (fallbackValue && typeof fallbackValue === 'object') {
            fallbackValue = fallbackValue[k];
          } else {
            break;
          }
        }
        if (typeof fallbackValue === 'string') {
          return fallbackValue;
        }
      }
      
      return key;
    } catch (error) {
      console.warn(`Translation error for key: ${key}`, error);
      return key;
    }
  };

  const switchLocale = (newLocale: string) => {
    // Save to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
    }
    // Update state (this will trigger re-render)
    setLocale(newLocale);
    
    // Also try to update router locale for consistency
    try {
      const { pathname, asPath, query } = router;
      router.push({ pathname, query }, asPath, { locale: newLocale, shallow: true });
    } catch (e) {
      // Ignore router errors, state update will handle the UI
    }
  };

  return (
    <I18nContext.Provider value={{ locale, t, switchLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (context === undefined) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}

// 便捷的翻译hook
export function useTranslation() {
  const { t } = useI18n();
  return { t };
}