import React, { useState, useEffect, useMemo } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import {
  Container,
  AppShell,
  Title,
  Button,
  Group,
  Text,
  Card,
  Stack,
  TextInput,
  Badge,
  Alert,
  Loader,
  Center,
  Modal,
  Tabs,
  Textarea,
  Table,
  ActionIcon,
  Tooltip,
  Checkbox,
  Paper,
  Progress,
  Divider,
  ScrollArea,
} from '@mantine/core';
import { useTranslation, useI18n } from '../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import ProblemForm from '../src/components/ProblemForm';

type Problem = {
  id: string;
  title: { en: string; zh: string };
  difficulty: string;
  tags: string[];
  description: { en: string; zh: string };
  examples?: Array<{ input: string; output: string }>;
  template?: { js?: string; python?: string; java?: string; cpp?: string; c?: string };
  solution?: { js?: string; python?: string; java?: string; cpp?: string; c?: string };
  tests?: Array<{ input: string; output: string }>;
};

const getDifficultyColor = (difficulty: string) => {
  switch (difficulty) {
    case 'Easy': return 'green';
    case 'Medium': return 'yellow';
    case 'Hard': return 'red';
    default: return 'gray';
  }
};

export default function ManageProblems() {
  const { t } = useTranslation();
  const { locale } = useI18n();
  
  // State for problem list
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // State for URL import
  const [importUrls, setImportUrls] = useState('');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; currentUrl?: string } | null>(null);
  const [importResult, setImportResult] = useState<{ success: number; failed: number; skipped: number; urlResults?: Array<{ url: string; success: number; failed: number; skipped: number; error?: string }> } | null>(null);
  
  // State for folder import
  const [folderPath, setFolderPath] = useState('');
  const [importingFolder, setImportingFolder] = useState(false);
  const [folderImportResult, setFolderImportResult] = useState<{ 
    success: number; 
    failed: number; 
    skipped: number; 
    total: number;
    fileResults?: Array<{ file: string; success: number; failed: number; skipped: number; error?: string }>;
    message?: string;
  } | null>(null);
  
  // State for delete
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  
  // State for search
  const [searchQuery, setSearchQuery] = useState('');

  // State for edit modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingProblem, setEditingProblem] = useState<Problem | null>(null);

  // Fetch problems
  const fetchProblems = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/problems');
      if (!response.ok) throw new Error('Failed to fetch problems');
      const data = await response.json();
      setProblems(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load problems');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProblems();
  }, []);

  // Filtered problems
  const filteredProblems = useMemo(() => {
    if (!searchQuery) return problems;
    const query = searchQuery.toLowerCase();
    return problems.filter(p => 
      p.id.toLowerCase().includes(query) ||
      p.title.en.toLowerCase().includes(query) ||
      p.title.zh.toLowerCase().includes(query)
    );
  }, [problems, searchQuery]);

  // Handle import from URLs (supports multiple URLs separated by newlines)
  const handleImportFromUrl = async () => {
    const urls = importUrls
      .split('\n')
      .map(url => url.trim())
      .filter(url => url.length > 0);
    
    if (urls.length === 0) return;
    
    setImporting(true);
    setImportResult(null);
    setImportProgress({ current: 0, total: urls.length });
    
    const urlResults: Array<{ url: string; success: number; failed: number; skipped: number; error?: string }> = [];
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      setImportProgress({ current: i + 1, total: urls.length, currentUrl: url });
      
      try {
        const response = await fetch('/api/import-problems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        
        const result = await response.json();
        
        if (!response.ok) {
          urlResults.push({ url, success: 0, failed: 0, skipped: 0, error: result.error || 'Import failed' });
          totalFailed++;
        } else {
          urlResults.push({ url, success: result.success, failed: result.failed, skipped: result.skipped });
          totalSuccess += result.success;
          totalFailed += result.failed;
          totalSkipped += result.skipped;
        }
      } catch (err) {
        urlResults.push({ url, success: 0, failed: 0, skipped: 0, error: err instanceof Error ? err.message : 'Import failed' });
      }
    }
    
    setImportResult({ success: totalSuccess, failed: totalFailed, skipped: totalSkipped, urlResults });
    setImportUrls('');
    setImportProgress(null);
    fetchProblems(); // Refresh list
    setImporting(false);
  };

  // Handle import from problems folder
  const handleImportFromProblemsFolder = async () => {
    setImportingFolder(true);
    setFolderImportResult(null);
    
    try {
      const response = await fetch('/api/import-from-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useProblemsFolder: true }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || 'Import failed');
      }
      
      setFolderImportResult(result);
      fetchProblems();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingFolder(false);
    }
  };

  // Handle import from custom folder
  const handleImportFromCustomFolder = async () => {
    if (!folderPath.trim()) return;
    
    setImportingFolder(true);
    setFolderImportResult(null);
    
    try {
      const response = await fetch('/api/import-from-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: folderPath.trim() }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || 'Import failed');
      }
      
      setFolderImportResult(result);
      setFolderPath('');
      fetchProblems();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingFolder(false);
    }
  };

  // Handle delete
  const handleDelete = async () => {
    if (selectedIds.length === 0) return;
    
    setDeleting(true);
    
    try {
      const response = await fetch('/api/delete-problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || 'Delete failed');
      }
      
      setSelectedIds([]);
      setDeleteModalOpen(false);
      fetchProblems(); // Refresh list
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  // Handle edit
  const handleEdit = (problem: Problem) => {
    setEditingProblem(problem);
    setEditModalOpen(true);
  };

  const handleEditSuccess = () => {
    setEditModalOpen(false);
    setEditingProblem(null);
    fetchProblems(); // Refresh list
  };

  const handleEditCancel = () => {
    setEditModalOpen(false);
    setEditingProblem(null);
  };

  // Toggle selection
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => 
      prev.includes(id) 
        ? prev.filter(x => x !== id)
        : [...prev, id]
    );
  };

  // Select all / none
  const toggleSelectAll = () => {
    if (selectedIds.length === filteredProblems.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredProblems.map(p => p.id));
    }
  };

  return (
    <AppShell header={{ height: HEADER_HEIGHT }}>
      <Head>
        <title>{t('manage.title')} - {t('header.title')}</title>
        <meta name="description" content="Manage your problem collection" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <AppHeader
        backHref="/"
        title={t('manage.title')}
        actions={
          <Button component={Link} href="/" variant="subtle" color="gray" size="xs" visibleFrom="sm">
            {t('manage.backToProblems')}
          </Button>
        }
      />

      <AppShell.Main>
        <Container size="xl" py="xl">
          <Stack gap="xl">
            <Title order={2}>{t('manage.title')}</Title>
            
            {error && (
              <Alert color="red" title={t('common.error')} withCloseButton onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            <Tabs defaultValue="import">
              <Tabs.List>
                <Tabs.Tab value="import">{t('manage.importTab')}</Tabs.Tab>
                <Tabs.Tab value="list">{t('manage.listTab')} ({problems.length})</Tabs.Tab>
              </Tabs.List>

              {/* Import Tab */}
              <Tabs.Panel value="import" pt="md">
                <Stack gap="lg">
                  {/* Import from Local Folder */}
                  <Card withBorder p="lg">
                    <Stack gap="md">
                      <Title order={4}>{t('manage.importFromFolder')}</Title>
                      <Text size="sm" c="dimmed">
                        {t('manage.importFromFolderDescription')}
                      </Text>
                      
                      {/* Import from problems folder */}
                      <Paper p="md" withBorder bg="var(--mantine-color-gray-light)">
                        <Group justify="space-between" align="center">
                          <div>
                            <Text fw={500}>{t('manage.problemsFolder')}</Text>
                            <Text size="xs" c="dimmed">{t('manage.problemsFolderHint')}</Text>
                          </div>
                          <Button 
                            onClick={handleImportFromProblemsFolder}
                            loading={importingFolder}
                            variant="light"
                          >
                            {t('manage.loadFromProblemsFolder')}
                          </Button>
                        </Group>
                      </Paper>
                      
                      <Divider label={t('manage.or')} labelPosition="center" />
                      
                      {/* Import from custom folder */}
                      <TextInput
                        label={t('manage.customFolderPath')}
                        description={t('manage.customFolderHint')}
                        placeholder="/path/to/your/problems/folder"
                        value={folderPath}
                        onChange={(e) => setFolderPath(e.currentTarget.value)}
                        disabled={importingFolder}
                      />
                      
                      <Group>
                        <Button 
                          onClick={handleImportFromCustomFolder}
                          loading={importingFolder}
                          disabled={!folderPath.trim()}
                        >
                          {t('manage.importFromCustomFolder')}
                        </Button>
                      </Group>
                      
                      {folderImportResult && (
                        <Alert 
                          color={folderImportResult.failed > 0 ? 'yellow' : 'green'} 
                          title={t('manage.importComplete')}
                          withCloseButton
                          onClose={() => setFolderImportResult(null)}
                        >
                          <Stack gap="xs">
                            {folderImportResult.message && (
                              <Text size="sm">{folderImportResult.message}</Text>
                            )}
                            {folderImportResult.total > 0 && (
                              <>
                                <Text size="sm">
                                  {t('manage.filesScanned', { count: folderImportResult.total })}
                                </Text>
                                <Text size="sm">
                                  {t('manage.importResultSuccess', { count: folderImportResult.success })}
                                </Text>
                                {folderImportResult.skipped > 0 && (
                                  <Text size="sm">
                                    {t('manage.importResultSkipped', { count: folderImportResult.skipped })}
                                  </Text>
                                )}
                                {folderImportResult.failed > 0 && (
                                  <Text size="sm" c="red">
                                    {t('manage.importResultFailed', { count: folderImportResult.failed })}
                                  </Text>
                                )}
                              </>
                            )}
                            {folderImportResult.fileResults && folderImportResult.fileResults.some(r => r.error) && (
                              <>
                                <Divider my="xs" />
                                <Text size="xs" fw={500}>{t('manage.errorDetails')}:</Text>
                                {folderImportResult.fileResults.filter(r => r.error).map((r, i) => (
                                  <Text key={i} size="xs" c="red">
                                    {r.file}: {r.error}
                                  </Text>
                                ))}
                              </>
                            )}
                          </Stack>
                        </Alert>
                      )}
                    </Stack>
                  </Card>

                  {/* Import from URL */}
                  <Card withBorder p="lg">
                    <Stack gap="md">
                      <Title order={4}>{t('manage.importFromUrl')}</Title>
                      <Text size="sm" c="dimmed">
                        {t('manage.importDescription')}
                      </Text>
                      
                      <Textarea
                        label={t('manage.remoteUrl')}
                        description={t('manage.multiUrlHint')}
                        placeholder={"https://example.com/problems1.json\nhttps://example.com/problems2.json"}
                        value={importUrls}
                        onChange={(e) => setImportUrls(e.currentTarget.value)}
                        disabled={importing}
                        minRows={3}
                        autosize
                      />
                      
                      <Group>
                        <Button 
                          onClick={handleImportFromUrl}
                          loading={importing}
                          disabled={!importUrls.trim()}
                        >
                          {t('manage.importButton')}
                        </Button>
                      </Group>
                      
                      {importProgress && (
                        <Stack gap="xs">
                          <Progress 
                            value={(importProgress.current / importProgress.total) * 100} 
                            size="sm"
                            animated
                          />
                          <Text size="xs" c="dimmed">
                            {t('manage.importProgress', { current: importProgress.current, total: importProgress.total })}
                            {importProgress.currentUrl && ` - ${importProgress.currentUrl.substring(0, 50)}...`}
                          </Text>
                        </Stack>
                      )}
                      
                      {importResult && (
                        <Alert 
                          color={importResult.failed > 0 ? 'yellow' : 'green'} 
                          title={t('manage.importComplete')}
                          withCloseButton
                          onClose={() => setImportResult(null)}
                        >
                          <Stack gap="xs">
                            <Text size="sm">
                              {t('manage.importResultSuccess', { count: importResult.success })}
                            </Text>
                            {importResult.skipped > 0 && (
                              <Text size="sm">
                                {t('manage.importResultSkipped', { count: importResult.skipped })}
                              </Text>
                            )}
                            {importResult.failed > 0 && (
                              <Text size="sm" c="red">
                                {t('manage.importResultFailed', { count: importResult.failed })}
                              </Text>
                            )}
                            {importResult.urlResults && importResult.urlResults.some(r => r.error) && (
                              <Divider my="xs" />
                            )}
                            {importResult.urlResults?.filter(r => r.error).map((r, i) => (
                              <Text key={i} size="xs" c="red">
                                {r.url.substring(0, 40)}... : {r.error}
                              </Text>
                            ))}
                          </Stack>
                        </Alert>
                      )}
                    </Stack>
                  </Card>

                  {/* JSON Format Reference */}
                  <Card withBorder p="lg">
                    <Stack gap="md">
                      <Title order={5}>{t('manage.jsonFormat')}</Title>
                      <Text size="sm" c="dimmed">
                        {t('manage.jsonFormatDescription')}
                      </Text>
                      <Paper p="sm" withBorder style={{ fontFamily: 'monospace', fontSize: '12px', overflow: 'auto' }}>
                        <pre style={{ margin: 0 }}>{`[
  {
    "id": "problem-id",
    "title": { "en": "Title", "zh": "标题" },
    "difficulty": "Easy|Medium|Hard",
    "tags": ["array", "hash-table"],
    "description": { "en": "...", "zh": "..." },
    "examples": [{ "input": "...", "output": "..." }],
    "template": { "js": "...", "python": "..." },
    "tests": [{ "input": "...", "output": "..." }]
  }
]`}</pre>
                      </Paper>
                    </Stack>
                  </Card>
                </Stack>
              </Tabs.Panel>

              {/* Problem List Tab */}
              <Tabs.Panel value="list" pt="md">
                <Stack gap="md">
                  <Group justify="space-between">
                    <TextInput
                      placeholder={t('manage.searchPlaceholder')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.currentTarget.value)}
                      style={{ flex: 1, maxWidth: 400 }}
                    />
                    
                    <Group>
                      {selectedIds.length > 0 && (
                        <>
                          <Text size="sm" c="dimmed">
                            {t('manage.selectedCount', { count: selectedIds.length })}
                          </Text>
                          <Button 
                            color="red" 
                            variant="light"
                            onClick={() => setDeleteModalOpen(true)}
                          >
                            {t('manage.deleteSelected')}
                          </Button>
                        </>
                      )}
                    </Group>
                  </Group>

                  {loading ? (
                    <Center py="xl">
                      <Loader />
                    </Center>
                  ) : filteredProblems.length === 0 ? (
                    <Center py="xl">
                      <Text c="dimmed">{t('manage.noProblems')}</Text>
                    </Center>
                  ) : (
                    <Table striped highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th style={{ width: 40 }}>
                            <Checkbox
                              checked={selectedIds.length === filteredProblems.length && filteredProblems.length > 0}
                              indeterminate={selectedIds.length > 0 && selectedIds.length < filteredProblems.length}
                              onChange={toggleSelectAll}
                            />
                          </Table.Th>
                          <Table.Th>ID</Table.Th>
                          <Table.Th>{t('manage.columnTitle')}</Table.Th>
                          <Table.Th>{t('manage.columnDifficulty')}</Table.Th>
                          <Table.Th>{t('manage.columnTags')}</Table.Th>
                          <Table.Th style={{ width: 120 }}>{t('manage.columnActions')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {filteredProblems.map((problem) => (
                          <Table.Tr key={problem.id}>
                            <Table.Td>
                              <Checkbox
                                checked={selectedIds.includes(problem.id)}
                                onChange={() => toggleSelect(problem.id)}
                              />
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm" style={{ fontFamily: 'monospace' }}>
                                {problem.id}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Link href={`/problems/${problem.id}`} style={{ textDecoration: 'none' }}>
                                <Text size="sm" c="blue">
                                  {problem.title[locale as keyof typeof problem.title] || problem.title.en}
                                </Text>
                              </Link>
                            </Table.Td>
                            <Table.Td>
                              <Badge color={getDifficultyColor(problem.difficulty)} size="sm">
                                {t(`homepage.difficulty.${problem.difficulty}`)}
                              </Badge>
                            </Table.Td>
                            <Table.Td>
                              <Group gap={4}>
                                {problem.tags?.slice(0, 2).map((tag) => (
                                  <Badge key={tag} size="xs" variant="light">
                                    {t(`tags.${tag}`) !== `tags.${tag}` ? t(`tags.${tag}`) : tag}
                                  </Badge>
                                ))}
                                {problem.tags?.length > 2 && (
                                  <Badge size="xs" variant="light" color="gray">
                                    +{problem.tags.length - 2}
                                  </Badge>
                                )}
                              </Group>
                            </Table.Td>
                            <Table.Td>
                              <Group gap="xs">
                                <Tooltip label={t('manage.viewProblem')}>
                                  <ActionIcon 
                                    variant="subtle" 
                                    component={Link} 
                                    href={`/problems/${problem.id}`}
                                  >
                                    👁
                                  </ActionIcon>
                                </Tooltip>
                                <Tooltip label={t('manage.editProblem')}>
                                  <ActionIcon 
                                    variant="subtle" 
                                    color="blue"
                                    onClick={() => handleEdit(problem)}
                                  >
                                    ✏️
                                  </ActionIcon>
                                </Tooltip>
                                <Tooltip label={t('manage.deleteProblem')}>
                                  <ActionIcon 
                                    variant="subtle" 
                                    color="red"
                                    onClick={() => {
                                      setSelectedIds([problem.id]);
                                      setDeleteModalOpen(true);
                                    }}
                                  >
                                    🗑
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </Stack>
              </Tabs.Panel>
            </Tabs>
          </Stack>
        </Container>
      </AppShell.Main>

      {/* Delete Confirmation Modal */}
      <Modal
        opened={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title={t('manage.deleteConfirmTitle')}
      >
        <Stack gap="md">
          <Text>
            {t('manage.deleteConfirmMessage', { count: selectedIds.length })}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteModalOpen(false)}>
              {t('manage.cancel')}
            </Button>
            <Button color="red" onClick={handleDelete} loading={deleting}>
              {t('manage.confirmDelete')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Edit Problem Modal */}
      <Modal
        opened={editModalOpen}
        onClose={handleEditCancel}
        title={t('manage.editProblemTitle')}
        size="xl"
        styles={{
          body: {
            maxHeight: 'calc(100vh - 200px)',
            overflowY: 'auto'
          }
        }}
      >
        {editingProblem && (
          <ProblemForm
            mode="edit"
            initialData={editingProblem as any}
            onSuccess={handleEditSuccess}
            onCancel={handleEditCancel}
            compact
          />
        )}
      </Modal>
    </AppShell>
  );
}
