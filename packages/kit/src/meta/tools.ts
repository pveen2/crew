// Which of Meta's Ads MCP tools a Crew agent gets, and how. From Meta's tool
// reference (developers.facebook.com → Ads MCP server → Available tools) and
// the server's own tools/list (115 tools on 25 November 2026).
//
// Reading goes through the connection. Every change goes through
// meta_ads_change and waits for the owner. A tool Meta adds later is in
// neither list, so no agent sees it until someone adds it here on purpose.

/** Reading only: reports, insights, accounts, creatives, catalogs, datasets, tests, logs, help. */
export const META_READ_TOOLS = [
  // Reporting and insights
  'ads_get_ad_entities',
  'ads_get_opportunity_score',
  'ads_insights_advertiser_context',
  'ads_insights_anomaly_signal',
  'ads_insights_auction_ranking_benchmarks',
  'ads_insights_industry_benchmark',
  'ads_insights_performance_trend',
  'ads_insights_performance_vs_peers',
  // Results of slow calls that hand back a job id
  'ads_get_async_result',
  // Accounts, Pages and field help
  'ads_get_ad_accounts',
  'ads_get_ad_account_pages',
  'ads_get_pages_for_business',
  'ads_get_field_context',
  // Creatives and media
  'ads_get_creatives',
  'ads_get_creative_ads',
  'ads_get_ad_images',
  'ads_get_ad_videos',
  'ads_get_ad_preview',
  'ads_library_search',
  // Instagram
  'ads_get_ig_accounts',
  'ads_get_ig_media',
  // Custom audiences
  'ads_get_ad_account_custom_audiences',
  'ads_get_custom_audience',
  'ads_get_custom_audience_adsets',
  // Catalogs
  'ads_catalog_list_catalogs',
  'ads_catalog_list_dpa_eligible_catalogs',
  'ads_catalog_get_diagnostics',
  'ads_catalog_get_dynamic_ads_health',
  'ads_catalog_get_data_sources',
  'ads_catalog_list_partner_integrations',
  'ads_catalog_list_products',
  'ads_catalog_get_suggested_filter',
  'ads_catalog_list_product_sets',
  'ads_catalog_list_guidance',
  'ads_catalog_list_product_feeds',
  'ads_catalog_get_product_feed_upload_sessions',
  'ads_catalog_get_feed_rules',
  'ads_catalog_event_source_get',
  'ads_catalog_event_source_get_catalogs',
  'ads_catalog_event_source_get_health',
  'ads_catalog_event_source_get_recommendations',
  'ads_catalog_list_video_template_assets',
  'ads_catalog_list_video_templates',
  // Signals and datasets
  'ads_get_datasets',
  'ads_get_dataset_details',
  'ads_get_dataset_stats',
  'ads_get_dataset_quality',
  'ads_pixel_event_read',
  'ads_pixel_parameter_read',
  'ads_get_customconversions',
  // Help, tests and activity
  'ads_get_errors',
  'ads_get_help_article',
  'ads_experiment_list_tests',
  'ads_experiment_check_eligibility',
  'ads_experiment_abtest_get_test',
  'ads_experiment_lift_get_test',
  'ads_account_get_activity_logs',
] as const;

/**
 * Changes, each one behind the owner's approval. New campaigns, ad sets and ads
 * start paused; ads_activate_entity and ads_boost_ig_post start spending money.
 *
 * Left out on purpose: ads_update_custom_audience_users (uploads customers'
 * hashed personal data to Meta); ads_create_upload_url, ads_finalize_upload and
 * the local-image upload tools (media comes in by URL with
 * ads_creative_upload_media); the ads_permission_* tools (who may use which
 * asset); ads_dataset_* changes; and Meta's own UI tools (offer_report,
 * ads_log_ui_interaction, ads_get_ad_preview_screenshot).
 * Reading leaves out ads_get_user_pages and ads_catalog_get_businesses, which
 * list everything the token can see, across businesses.
 */
export const META_WRITE_TOOLS = [
  // Campaigns, ad sets, ads and creatives
  'ads_create_campaign',
  'ads_create_ad_set',
  'ads_create_ad',
  'ads_create_creative',
  'ads_creative_update',
  'ads_creative_delete',
  'ads_creative_upload_media',
  'ads_duplicate_entity',
  'ads_update_entity',
  'ads_activate_entity',
  'ads_boost_ig_post',
  // Custom audiences (rules and lookalikes, no customer lists)
  'ads_create_custom_audience',
  'ads_update_custom_audience',
  'ads_delete_custom_audience',
  // Catalogs
  'ads_catalog_create',
  'ads_catalog_update_catalog',
  'ads_catalog_product_create',
  'ads_catalog_update_product',
  'ads_catalog_delete_product',
  'ads_catalog_create_product_set',
  'ads_catalog_update_product_set',
  'ads_catalog_product_set_delete',
  'ads_catalog_create_product_feed',
  'ads_catalog_update_product_feed',
  'ads_catalog_create_product_feed_upload_session',
  'ads_catalog_product_feed_delete',
  'ads_catalog_create_feed_rule',
  'ads_catalog_update_feed_rule',
  'ads_catalog_product_feed_delete_rule',
  'ads_catalog_event_source_connect',
  'ads_catalog_event_source_disconnect',
  'ads_catalog_create_video_template',
  // Pixel rules
  'ads_pixel_event_create',
  'ads_pixel_event_update',
  'ads_pixel_event_delete',
  'ads_pixel_parameter_create',
  'ads_pixel_parameter_update',
  'ads_pixel_parameter_delete',
  // Experiments
  'ads_experiment_abtest_create_test',
  'ads_experiment_abtest_update_test',
  'ads_experiment_lift_create_test',
] as const;

/** Changes that start or raise spend. The approval card says so. */
export const META_SPEND_TOOLS: readonly string[] = ['ads_activate_entity', 'ads_boost_ig_post'];
