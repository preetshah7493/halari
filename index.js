const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

class DataProcessor {
  constructor() {
    this.extractionCache = new Map();
    this.performanceMetrics = {
      totalRequests: 0,
      successfulExtractions: 0,
      failedExtractions: 0,
      averageProcessingTime: 0,
      cacheHits: 0
    };
    this.processingQueue = [];
    this.isProcessing = false;
  }

  extractDataField($, fieldPattern, fallbackStrategies = true) {
    try {
      let element = $(`p:contains("${fieldPattern}")`).first();
      if (element.length > 0) {
        const text = element.text();
        const colonIndex = text.indexOf(':');
        if (colonIndex !== -1) {
          return text.substring(colonIndex + 1).trim();
        }
      }

      if (fallbackStrategies) {
        const normalizedPattern = fieldPattern.toLowerCase().replace(/[:\s]/g, '');
        element = $('p').filter((_, el) => {
          const elementText = $(el).text().toLowerCase().replace(/[:\s]/g, '');
          return elementText.includes(normalizedPattern);
        }).first();

        if (element.length > 0) {
          const text = element.text();
          const parts = text.split(':');
          if (parts.length > 1) {
            return parts[1].trim();
          }
        }
      }

      return '';
    } catch (error) {
      console.warn(`Field extraction failed for ${fieldPattern}:`, error.message);
      return '';
    }
  }

  async processMemberData(memberId) {
    const startTime = Date.now();
    const url = `https://www.djparin.in/member_details_open.php?member_id=${memberId}`;

    try {
      // Check cache first for performance optimization
      const cacheKey = this.generateCacheKey(memberId);
      if (this.extractionCache.has(cacheKey)) {
        this.performanceMetrics.cacheHits++;
        return {
          ...this.extractionCache.get(cacheKey),
          fromCache: true,
          processingTime: 0
        };
      }

      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DataExtractor/2.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive'
        }
      });

      const $ = cheerio.load(response.data);

      const extractionPhases = {
        phase1: this.extractPrimaryFields($),
        phase2: this.extractSecondaryFields($),
        phase3: this.extractMetadataFields($)
      };

      const memberData = {
        memberId: parseInt(memberId),
        ...extractionPhases.phase1,
        ...extractionPhases.phase2,
        ...extractionPhases.phase3,
        extractionMetadata: {
          timestamp: new Date().toISOString(),
          processingTime: Date.now() - startTime,
          extractionQuality: this.assessDataQuality(extractionPhases),
          processingVersion: '2.1.0'
        }
      };

      const validationResult = this.validateExtractedData(memberData);
      if (validationResult.isValid) {
        this.extractionCache.set(cacheKey, memberData);
        this.updateSuccessMetrics(Date.now() - startTime);
      } else {
        memberData.validationWarnings = validationResult.warnings;
        this.updateFailureMetrics(Date.now() - startTime);
      }

      return memberData;

    } catch (error) {
      this.updateFailureMetrics(Date.now() - startTime);
      throw new Error(`Data extraction failed for member ${memberId}: ${error.message}`);
    }
  }

  extractPrimaryFields($) {
    return {
      lmNumber: this.extractDataField($, 'LM Number'),
      name: this.extractDataField($, 'Name'),
      surname: this.extractDataField($, 'Surname'),
      fullName: $('h2').first().text().trim()
    };
  }

  extractSecondaryFields($) {
    return {
      gaam: this.extractDataField($, 'Gaam'),
      area: this.extractDataField($, 'Area'),
      mobileNumber: this.extractDataField($, 'Mobile Number'),
      status: this.extractDataField($, 'Status')
    };
  }

  extractMetadataFields($) {
    const imageElement = $('img.profile-img').first();
    return {
      imageUrl: imageElement.length > 0 ? imageElement.attr('src') : '/assets/dummy.JPG'
    };
  }

  assessDataQuality(extractionPhases) {
    const allFields = { ...extractionPhases.phase1, ...extractionPhases.phase2 };
    const filledFields = Object.values(allFields).filter(value => value && value.trim() !== '');
    const totalFields = Object.keys(allFields).length;
    const qualityScore = (filledFields.length / totalFields) * 100;

    if (qualityScore >= 90) return 'EXCELLENT';
    if (qualityScore >= 75) return 'GOOD';
    if (qualityScore >= 60) return 'ACCEPTABLE';
    return 'POOR';
  }

  validateExtractedData(data) {
    const warnings = [];
    const requiredFields = ['lmNumber', 'name', 'surname'];

    requiredFields.forEach(field => {
      if (!data[field] || data[field].trim() === '') {
        warnings.push(`Missing or empty required field: ${field}`);
      }
    });

    if (data.lmNumber && !/^\d+$/.test(data.lmNumber)) {
      warnings.push('LM Number should be numeric');
    }

    return {
      isValid: warnings.length === 0,
      warnings,
      qualityScore: this.assessDataQuality({ 
        phase1: { lmNumber: data.lmNumber, name: data.name, surname: data.surname },
        phase2: { gaam: data.gaam, area: data.area, mobileNumber: data.mobileNumber, status: data.status }
      })
    };
  }

  // Performance optimization utilities
  generateCacheKey(memberId) {
    return crypto.createHash('md5').update(`member_${memberId}_v2`).digest('hex');
  }

  updateSuccessMetrics(processingTime) {
    this.performanceMetrics.totalRequests++;
    this.performanceMetrics.successfulExtractions++;
    this.updateAverageProcessingTime(processingTime);
  }

  updateFailureMetrics(processingTime) {
    this.performanceMetrics.totalRequests++;
    this.performanceMetrics.failedExtractions++;
    this.updateAverageProcessingTime(processingTime);
  }

  updateAverageProcessingTime(newTime) {
    const total = this.performanceMetrics.totalRequests;
    const current = this.performanceMetrics.averageProcessingTime;
    this.performanceMetrics.averageProcessingTime = ((current * (total - 1)) + newTime) / total;
  }

  async processBatchData(startId, endId, options = {}) {
    const { batchSize = 3, delay = 1000, maxConcurrency = 5 } = options;
    const results = { successful: [], failed: [], summary: {} };
    const startTime = Date.now();

    for (let i = startId; i <= endId; i += batchSize) {
      const batchEnd = Math.min(i + batchSize - 1, endId);
      const batchPromises = [];

      for (let memberId = i; memberId <= batchEnd; memberId++) {
        batchPromises.push(
          this.processMemberData(memberId)
            .then(data => ({ success: true, data }))
            .catch(error => ({ success: false, memberId, error: error.message }))
        );
      }

      const batchResults = await Promise.all(batchPromises);

      batchResults.forEach(result => {
        if (result.success) {
          results.successful.push(result.data);
        } else {
          results.failed.push({ memberId: result.memberId, error: result.error });
        }
      });

      if (batchEnd < endId) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    results.summary = {
      totalProcessed: endId - startId + 1,
      successCount: results.successful.length,
      failureCount: results.failed.length,
      processingTime: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };

    return results;
  }

  getPerformanceMetrics() {
    return {
      ...this.performanceMetrics,
      cacheSize: this.extractionCache.size,
      uptime: process.uptime()
    };
  }
}

const dataProcessor = new DataProcessor();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
  next();
});

app.get('/api/member/:id', async (req, res) => {
  const { id } = req.params;
  const { include_metadata = 'true', format = 'json' } = req.query;

  try {
    const memberId = parseInt(id);
    if (isNaN(memberId) || memberId < 1) {
      return res.status(400).json({
        error: 'Invalid member ID format',
        code: 'VALIDATION_ERROR',
        details: 'Member ID must be a positive integer',
        timestamp: new Date().toISOString()
      });
    }

    console.log(`🔍 Processing member extraction request for ID: ${memberId}`);
    
    const memberData = await dataProcessor.processMemberData(memberId);

    const response = {
      success: true,
      data: memberData,
      metadata: {
        requestId: crypto.randomUUID(),
        processingTime: memberData.extractionMetadata.processingTime,
        cached: memberData.fromCache || false,
        timestamp: new Date().toISOString()
      }
    };

    if (include_metadata === 'false') {
      delete response.data.extractionMetadata;
      delete response.metadata;
    }

    res.json(response);

  } catch (error) {
    console.error(`❌ Member extraction failed for ID ${id}:`, error.message);
    res.status(500).json({
      error: 'Data extraction failed',
      code: 'EXTRACTION_ERROR',
      details: error.message,
      memberId: id,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/members', async (req, res) => {
  const { 
    start = 1, 
    end = 5, 
    batch_size = 3, 
    delay = 1000,
    include_failed = 'true',
    max_range = 50
  } = req.query;

  try {
    const startId = parseInt(start);
    const endId = parseInt(end);
    const batchSize = parseInt(batch_size);
    const delayMs = parseInt(delay);
    const maxRange = parseInt(max_range);

    if (isNaN(startId) || isNaN(endId) || startId < 1 || endId < startId) {
      return res.status(400).json({
        error: 'Invalid range parameters',
        code: 'RANGE_VALIDATION_ERROR',
        details: 'Start and end must be positive integers with end >= start'
      });
    }

    if (endId - startId + 1 > maxRange) {
      return res.status(400).json({
        error: 'Range too large',
        code: 'RANGE_LIMIT_EXCEEDED',
        details: `Maximum range is ${maxRange} members per request`,
        maxAllowed: maxRange
      });
    }

    console.log(`🔄 Processing batch extraction: ${startId} to ${endId}`);

    const batchResults = await dataProcessor.processBatchData(startId, endId, {
      batchSize: batchSize,
      delay: delayMs
    });

    const response = {
      success: true,
      results: {
        successful: batchResults.successful,
        summary: batchResults.summary
      },
      metadata: {
        requestId: crypto.randomUUID(),
        processingStrategy: 'batch_concurrent',
        performanceMetrics: dataProcessor.getPerformanceMetrics(),
        timestamp: new Date().toISOString()
      }
    };

    if (include_failed === 'true' && batchResults.failed.length > 0) {
      response.results.failed = batchResults.failed;
    }

    res.json(response);

  } catch (error) {
    console.error('❌ Batch extraction failed:', error.message);
    res.status(500).json({
      error: 'Batch extraction failed',
      code: 'BATCH_ERROR',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/health', (req, res) => {
  const healthData = {
    status: 'operational',
    version: '2.1.0',
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      platform: process.platform
    },
    performance: dataProcessor.getPerformanceMetrics(),
    capabilities: {
      maxConcurrentRequests: 10,
      supportedFormats: ['json'],
      cachingEnabled: true,
      batchProcessing: true
    },
    timestamp: new Date().toISOString()
  };

  res.json(healthData);
});

app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    timestamp: new Date().toISOString()
  });
});

// app.use('*', (req, res) => {
//   res.status(404).json({
//     error: 'Endpoint not found',
//     code: 'NOT_FOUND',
//     availableEndpoints: [
//       'GET /api/member/:id',
//       'GET /api/members',
//       'GET /api/health'
//     ],
//     timestamp: new Date().toISOString()
//   });
// });

app.listen(PORT, () => {
  console.log(`🚀 Sophisticated Data Extraction Server`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🔗 Endpoints:`);
  console.log(`   • Single Member: http://localhost:${PORT}/api/member/44`);
  console.log(`   • Batch Members: http://localhost:${PORT}/api/members?start=1&end=10`);
  console.log(`   • Health Check:  http://localhost:${PORT}/api/health`);
  console.log(`⚡ Advanced features: Caching, Batch Processing, Performance Metrics`);
});
