import { useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router';
import type { ShowcaseTemplate, TemplateCategory } from '~/types/showcase-template';
import { TEMPLATE_CATEGORIES, CATEGORY_LABELS } from '~/types/showcase-template';
import { loadShowcaseTemplates } from '~/utils/showcase-templates';
import { TemplatePreviewModal } from '~/components/templates/TemplatePreviewModal';

// ── Gallery ─────────────────────────────────────────────────────────────────

export default function TemplatesGallery() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [templates, setTemplates] = useState<ShowcaseTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<ShowcaseTemplate | null>(null);

  useEffect(() => {
    loadShowcaseTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const selectedId = searchParams.get('selected');

    if (selectedId && templates.length > 0) {
      const found = templates.find((t) => t.id === selectedId);

      if (found) {
        setSelectedTemplate(found);
      }
    }
  }, [searchParams, templates]);

  const filteredTemplates = useMemo(() => {
    let result = templates;

    if (activeCategory !== 'all') {
      result = result.filter((t) => t.category === activeCategory);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();

      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)),
      );
    }

    return result;
  }, [templates, activeCategory, searchQuery]);

  const handleCloseModal = useCallback(() => {
    setSelectedTemplate(null);

    const newParams = new URLSearchParams(searchParams);
    newParams.delete('selected');
    setSearchParams(newParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleCardClick = useCallback((template: ShowcaseTemplate) => {
    setSelectedTemplate(template);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="i-svg-spinners:90-ring-with-bg text-3xl text-bolt-elements-loader-progress" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto modern-scrollbar" style={{ backgroundColor: '#0a0a0a' }}>
      {/* Hero Section */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-6">
        <div className="flex items-center gap-3 mb-4">
          <Link
            to="/"
            prefetch="intent"
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium no-underline transition-all duration-200 group border border-[#333333] hover:border-[#555555] hover:bg-[#2a2a2a]"
            style={{ color: '#9ca3af', backgroundColor: '#1a1a1a' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#ffffff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#9ca3af';
            }}
          >
            <div className="i-ph:arrow-left text-base transition-transform duration-200 group-hover:-translate-x-0.5" />
            Back to Home
          </Link>
        </div>
        <h1 className="text-3xl font-bold text-white mb-2">Templates</h1>
        <p className="text-base text-[#9ca3af]">
          Curated templates to kickstart your next project. Preview live demos and clone with one click.
        </p>
      </div>

      {/* Search & Filters */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-6">
        <div className="relative mb-4">
          <div className="i-ph:magnifying-glass text-lg text-[#9ca3af] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search templates..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg text-sm text-white placeholder-[#666] outline-none transition-colors border border-[#333333] focus:border-[#3b82f6]"
            style={{ backgroundColor: '#1a1a1a' }}
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 modern-scrollbar">
          {TEMPLATE_CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.id;

            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all duration-200 border ${
                  isActive
                    ? 'bg-[#3b82f6] text-white border-[#3b82f6]'
                    : 'bg-[#1a1a1a] text-[#9ca3af] border-[#333333] hover:bg-[#2a2a2a] hover:text-white'
                }`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Template Grid */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-12">
        {filteredTemplates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="i-ph:magnifying-glass text-4xl text-[#333] mb-3" />
            <p className="text-[#9ca3af] text-sm">No templates found matching your search.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredTemplates.map((template) => (
              <TemplateGalleryCard key={template.id} template={template} onClick={handleCardClick} />
            ))}
          </div>
        )}
      </div>

      <TemplatePreviewModal template={selectedTemplate} onClose={handleCloseModal} />
    </div>
  );
}

// ── Card colors ─────────────────────────────────────────────────────────────

const CATEGORY_BADGE_COLORS: Record<string, { text: string; bg: string }> = {
  'landing-page': { text: '#22d3ee', bg: 'rgba(34, 211, 238, 0.12)' },
  portfolio: { text: '#818cf8', bg: 'rgba(129, 140, 248, 0.12)' },
  'online-store': { text: '#4ade80', bg: 'rgba(74, 222, 128, 0.12)' },
  dashboard: { text: '#fb923c', bg: 'rgba(251, 146, 60, 0.12)' },
  saas: { text: '#c084fc', bg: 'rgba(192, 132, 252, 0.12)' },
  'ai-app': { text: '#f472b6', bg: 'rgba(244, 114, 182, 0.12)' },
};

// ── Gallery card (static screenshot thumbnail) ──────────────────────────────

interface TemplateGalleryCardProps {
  template: ShowcaseTemplate;
  onClick: (template: ShowcaseTemplate) => void;
}

function TemplateGalleryCard({ template, onClick }: TemplateGalleryCardProps) {
  const [imgError, setImgError] = useState(false);
  const badgeColors = CATEGORY_BADGE_COLORS[template.category] || { text: '#9ca3af', bg: 'rgba(156, 163, 175, 0.12)' };
  const screenshotUrl = `/screenshots/${template.id}.png`;

  return (
    <button
      onClick={() => onClick(template)}
      className="group text-left rounded-xl overflow-hidden transition-all duration-300 bg-[#1a1a1a] border border-[#333333] hover:border-[#555555] hover:-translate-y-1 hover:shadow-xl hover:shadow-black/30"
    >
      {/* Screenshot preview */}
      <div className="relative aspect-[16/10] overflow-hidden" style={{ backgroundColor: '#141414' }}>
        {!imgError ? (
          <img
            src={screenshotUrl}
            alt={`${template.name} preview`}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover object-top"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2">
            <div className={`${template.icon} text-4xl`} style={{ color: badgeColors.text }} />
            <span className="text-xs text-[#666]">Preview unavailable</span>
          </div>
        )}

        {/* Bottom gradient overlay */}
        {!imgError && (
          <div
            className="absolute inset-x-0 bottom-0 h-20 pointer-events-none"
            style={{ background: 'linear-gradient(to top, #1a1a1a 0%, transparent 100%)' }}
          />
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-300 flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-all duration-300 scale-90 group-hover:scale-100 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#3b82f6]/90 backdrop-blur-sm shadow-lg">
            <div className="i-ph:eye text-base" />
            Preview
          </div>
        </div>
      </div>

      {/* Card body */}
      <div className="p-5">
        <div className="flex items-center gap-2.5 mb-2">
          <div className={`${template.icon} text-lg flex-shrink-0`} style={{ color: badgeColors.text }} />
          <h3 className="text-[15px] font-semibold text-white truncate">{template.name}</h3>
        </div>
        <p className="text-xs text-[#9ca3af] line-clamp-2 mb-3 leading-relaxed">{template.description}</p>
        <div className="flex items-center justify-between">
          <span
            className="text-xs px-2.5 py-1 rounded-full font-medium"
            style={{ backgroundColor: badgeColors.bg, color: badgeColors.text }}
          >
            {CATEGORY_LABELS[template.category] || template.category}
          </span>
          <div className="i-ph:arrow-right text-sm text-[#666] opacity-0 group-hover:opacity-100 transition-opacity group-hover:text-white" />
        </div>
      </div>
    </button>
  );
}
